import type { Pool } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob } from './loop.js';

/** 전달 잡 락. 정산 잡과 나눠, 큰 시즌 확정이 길어도 SETTLED 전이와 경고가 밀리지 않게 한다 */
const DELIVERY_LOCK = 'podium:delivery';

/**
 * 전달 대기 시즌 하나 (SP_LIST_REWARD_PENDING)
 * @author trisakion
 */
export interface PendingSeason {
    rankingId: number;
    seasonNo: number;
    /** 남은 전달 대상 수 (PENDING) */
    remaining: number;
}

/**
 * 한 번 관측의 경고 변화. 상태가 바뀔 때만 채운다 — 같은 경고를 주기마다 반복하지 않는다
 * @author trisakion
 */
export interface DeliveryEvents {
    /** 이번에 ack 정체로 들어선 시즌 */
    stalled: { season: PendingSeason; sinceMs: number }[];
    /** 정체였다가 남은 수가 바뀐 시즌 */
    recovered: PendingSeason[];
    /** 적체 경고 시작(true)·해소(false), 변화 없으면 null */
    backlog: boolean | null;
}

/**
 * ack 정체와 DELIVERING 적체를 판정하는 관측기를 만든다 (01_DESIGN 7.7 알림).
 * 정체: 남은 수가 stallMs 동안 그대로인 시즌. 기준 시각은 이 프로세스가 처음 본 때나 마지막으로 바뀐 때라, 워커가 재시작하면 다시 잰다.
 * 적체: DELIVERING 시즌 수가 backlogMax 초과.
 * @param stallMs 정체 기준(ms)
 * @param backlogMax 적체 임계치 (시즌 수)
 * @returns 관측 함수 (남은 수 0인 시즌은 곧 SETTLED라 넣지 않는다, 적체 판정용 전체 시즌 수, 현재 ms)
 * @author trisakion
 */
export function createDeliveryWatch(stallMs: number, backlogMax: number): (seasons: PendingSeason[], total: number, now: number) => DeliveryEvents {
    const seen = new Map<string, { remaining: number; since: number; warned: boolean }>();
    let backlogWarned = false;
    return (seasons, total, now) => {
        const out: DeliveryEvents = { stalled: [], recovered: [], backlog: null };
        const live = new Set<string>();
        for (const s of seasons) {
            const key = `${s.rankingId}:${s.seasonNo}`;
            live.add(key);
            const prev = seen.get(key);
            if (!prev || prev.remaining !== s.remaining) {
                if (prev?.warned)
                    out.recovered.push(s);
                seen.set(key, { remaining: s.remaining, since: now, warned: false });
            } else if (!prev.warned && now - prev.since > stallMs) {
                prev.warned = true;
                out.stalled.push({ season: s, sinceMs: now - prev.since });
            }
        }
        for (const key of seen.keys())
            if (!live.has(key))
                seen.delete(key);
        const over = total > backlogMax;
        if (over !== backlogWarned)
            out.backlog = backlogWarned = over;
        return out;
    };
}

/**
 * 보상 전달 잡을 시작한다 (01_DESIGN 7.5, 7.7): 남은 대상이 없는 DELIVERING 시즌을 SETTLED로 넘기고, ack 정체·적체와 장기 보류를 경고한다.
 * 전달 자체는 게임 서버가 API로 pull·ack한다. 이 잡은 끝을 맺고 연동 장애를 알리기만 한다.
 * @param pool 메인 DB 풀
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 * @modified 2026-11-04 trisakion 장기 보류 경고 추가 (D-82)
 */
export function startDelivery(pool: Pool): () => Promise<void> {
    const { intervalMs, stallSec, backlogMax, reviewHoldWarnSec } = config.delivery;
    const watch = createDeliveryWatch(stallSec * 1000, backlogMax);
    let overdueHolds = new Set<string>();
    const stop = startJob(pool, { name: 'delivery', lock: DELIVERY_LOCK, intervalMs }, async (ctx) => {
        const { result, rows } = await callSp(ctx.conn, 'SP_LIST_REWARD_PENDING', []);
        if (result !== SpResult.OK)
            throw new Error(`SP_LIST_REWARD_PENDING result ${result}`);
        const waiting: PendingSeason[] = [];
        for (const r of rows) {
            const s: PendingSeason = { rankingId: r.ranking_id, seasonNo: r.season_no, remaining: Number(r.remaining) };
            if (s.remaining > 0) {
                waiting.push(s);
                continue;
            }
            await ctx.checkpoint();
            const settled = await callSp(ctx.conn, 'SP_UPDATE_SEASON_SETTLED', [s.rankingId, s.seasonNo]);
            // 1016: 목록을 읽은 뒤 전달 대상이 다시 생김. 보류 전환이 없어(D-77) 방어용이다. 다음 주기에 다시 본다
            if (settled.result === SpResult.OK)
                logger.info(`rewards delivered ranking=${s.rankingId} season=${s.seasonNo} → SETTLED`);
            else if (settled.result !== SpResult.REWARD_REMAINING)
                throw new Error(`SP_UPDATE_SEASON_SETTLED result ${settled.result} ranking=${s.rankingId} season=${s.seasonNo}`);
        }
        const ev = watch(waiting, rows.length, Date.now());
        for (const { season: s, sinceMs } of ev.stalled)
            logger.warn(`reward ack stalled ranking=${s.rankingId} season=${s.seasonNo}: ${s.remaining} pending unchanged for ${Math.floor(sinceMs / 60_000)} min — check the game server reward pull`);
        for (const s of ev.recovered)
            logger.info(`reward ack resumed ranking=${s.rankingId} season=${s.seasonNo} remaining=${s.remaining}`);
        if (ev.backlog === true)
            logger.warn(`DELIVERING backlog: ${rows.length} seasons > ${backlogMax} — each keeps ranking_entry/ranking_submit_key partitions (limit 8192 per table)`);
        else if (ev.backlog === false)
            logger.info(`DELIVERING backlog cleared: ${rows.length} seasons`);

        const holds = await callSp(ctx.conn, 'SP_LIST_REVIEW_HOLD_OVERDUE', [reviewHoldWarnSec]);
        if (holds.result !== SpResult.OK)
            throw new Error(`SP_LIST_REVIEW_HOLD_OVERDUE result ${holds.result}`);
        const current = new Set<string>();
        for (const r of holds.rows) {
            const label = `ranking=${r.ranking_id} season=${r.season_no}`;
            current.add(label);
            if (!overdueHolds.has(label))
                logger.warn(`review hold overdue ${label}: ${Math.floor(Number(r.overdue_sec) / 60)} min past review_until — rewards for the whole season are delayed until the hold is released`);
        }
        for (const label of overdueHolds)
            if (!current.has(label))
                logger.info(`review hold cleared ${label}`);
        overdueHolds = current;
    });
    logger.info(`delivery started (interval ${intervalMs}ms, ack stall ${stallSec}s, backlog > ${backlogMax} seasons, review hold > ${reviewHoldWarnSec}s)`);
    return stop;
}
