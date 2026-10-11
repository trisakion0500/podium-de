import type { Pool, PoolConnection } from 'mysql2/promise';
import { RangeType, SeasonStatus, SettlingState, SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp, LockNotAcquiredError, withLock } from '../core/db.js';
import { logger } from '../core/logger.js';
import { deleteSeasonKeys, seasonKeys, type Redis } from '../core/redis.js';
import { startJob, type JobContext } from './loop.js';
import { RECOVERY_LOCK } from './recovery.js';

/** 정산 잡 락. 정산은 동시에 한 시즌만 한다 — 작업 테이블 ranking_entry_settling이 하나다 (01_DESIGN 7.3) */
export const SETTLE_LOCK = 'podium:settle';

/** 복구 잡 락 대기(초). 재구축이 100만 명에서 약 11초라(1.7) 그보다 넉넉히 기다린다. 못 잡으면 다음 주기에 다시 한다 */
const RECOVERY_LOCK_WAIT_SEC = 30;

/** 정산 시작 조건이 settle_at 뒤로 이만큼 넘게 안 풀리면 경고한다 (긴 트랜잭션, 리컨실러 정지) */
const STALL_WARN_MS = 300_000;

/** SP_LIST_SETTLE_TARGET 행 */
interface SettleTarget {
    rankingId: number;
    seasonNo: number;
    status: number;
    settleAt: Date;
    dbNow: Date;
}

/** 시작 조건 정체를 이미 경고한 시즌 (프로세스당 한 번) */
const stallWarned = new Set<string>();

/**
 * 복구 잡 락을 기다려 잡고 작업한다. 정산 락과 따로 잡으므로 전용 커넥션이 하나 더 쓰인다.
 * 못 잡으면 일반 오류로 바꾼다 — 루프는 LockNotAcquiredError를 "다른 워커가 이 잡을 실행 중"으로 보고 조용히 넘기기 때문이다.
 * @param pool 메인 DB 풀
 * @param work 락을 쥔 동안 할 작업
 * @returns 작업 결과
 */
async function withRecoveryLock<T>(pool: Pool, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
    try {
        return await withLock(pool, RECOVERY_LOCK, RECOVERY_LOCK_WAIT_SEC, work);
    } catch (err) {
        if (err instanceof LockNotAcquiredError)
            throw new Error(`recovery lock busy for ${RECOVERY_LOCK_WAIT_SEC}s, retry next cycle`, { cause: err });
        throw err;
    }
}

/**
 * CLOSED 시즌의 정산을 시작한다 (01_DESIGN 7.1). SETTLING 커밋은 복구 잡 락 안에서 한다 (5.6, D-60).
 * @param pool 메인 DB 풀
 * @param t 대상 시즌
 * @returns 시작했으면 true, 조건이 아직이면 false
 */
async function startSettling(pool: Pool, t: SettleTarget): Promise<boolean> {
    const result = await withRecoveryLock(pool, async (conn) => (await callSp(conn, 'SP_START_SETTLING', [t.rankingId, t.seasonNo, config.recovery.marginSec])).result);
    if (result === SpResult.OK) {
        logger.info(`settling started ranking=${t.rankingId} season=${t.seasonNo}`);
        return true;
    }
    if (result !== SpResult.SETTLE_NOT_DUE && result !== SpResult.SETTLE_WAITING_TRX && result !== SpResult.SETTLE_WAITING_SYNC)
        throw new Error(`SP_START_SETTLING result ${result} ranking=${t.rankingId} season=${t.seasonNo}`);
    const key = `${t.rankingId}:${t.seasonNo}`;
    if (t.dbNow.getTime() - t.settleAt.getTime() > STALL_WARN_MS && !stallWarned.has(key)) {
        stallWarned.add(key);
        const why = result === SpResult.SETTLE_WAITING_TRX ? 'a transaction started before end_at is still open' : 'reconciler synced_at has not passed end_at + margin';
        logger.warn(`settling stalled ranking=${t.rankingId} season=${t.seasonNo}: ${why} (result ${result})`);
    }
    return false;
}

/**
 * SETTLING 시즌의 가순위를 매기고 REVIEW로 넘긴다 (01_DESIGN 7.3). 단계마다 상태가 DB에 남아 어디서 끊겨도 다시 부르면 이어진다(8.6).
 * 꺼내기 → 가순위 청크 반복 → 되돌리기 → Redis 시즌 키 삭제(복구 잡 락 안) → REVIEW.
 * @param pool 메인 DB 풀
 * @param ctx 정산 락을 쥔 실행 문맥
 * @param redis Redis 클라이언트
 * @param t 대상 시즌
 * @returns 완료 Promise
 */
async function provisionalRank(pool: Pool, ctx: JobContext, redis: Redis, t: SettleTarget): Promise<void> {
    const label = `ranking=${t.rankingId} season=${t.seasonNo}`;
    const started = Date.now();
    let ranked = 0;
    for (;;) {
        await ctx.checkpoint();
        const { result, rows } = await callSp(ctx.conn, 'SP_SETTLING_EXCHANGE', [t.rankingId, t.seasonNo]);
        // 1007(작업 테이블에 다른 시즌), 1008(꺼낸 뒤 쓰기)은 사람이 확인해야 한다. 루프가 매 주기 오류 로그로 알린다.
        if (result !== SpResult.OK)
            throw new Error(`SP_SETTLING_EXCHANGE result ${result} ${label}`);
        if (rows[0].settling_state === SettlingState.RETURNED)
            break;
        for (;;) {
            await ctx.checkpoint();
            const chunk = await callSp(ctx.conn, 'SP_UPDATE_SETTLING_RANK', [t.rankingId, t.seasonNo, config.scheduler.settleChunk]);
            if (chunk.result !== SpResult.OK)
                throw new Error(`SP_UPDATE_SETTLING_RANK result ${chunk.result} ${label}`);
            const n = Number(chunk.rows[0].ranked_count);
            if (n === 0)
                break;
            ranked += n;
        }
    }

    await ctx.checkpoint();
    await withRecoveryLock(pool, () => deleteSeasonKeys(redis, seasonKeys(t.rankingId, t.seasonNo)));
    const { result } = await callSp(ctx.conn, 'SP_UPDATE_SEASON_REVIEW', [t.rankingId, t.seasonNo]);
    if (result !== SpResult.OK)
        throw new Error(`SP_UPDATE_SEASON_REVIEW result ${result} ${label}`);
    logger.info(`provisional ranks done ${label} ranked=${ranked} in ${Date.now() - started}ms → REVIEW`);
}

/** tier_snapshot의 구간 하나 (SP_START_FINALIZING이 ranking_reward_tier에서 고정) */
interface RewardTier {
    tier_no: number;
    range_type: number;
    range_from: number;
    range_to: number;
}

/**
 * 보상을 받는 순위 사이에 아무 구간에도 들지 않는 순위 범위를 찾는다 (01_DESIGN 2.6, D-69).
 * SP_UPDATE_FINAL_RANK와 같은 규칙으로 구간마다 순위 범위를 계산한다 — RANK [from, to], PERCENT는 앞 사람 비율
 * (r-1)/P가 [from-1, to)%인 r, 즉 ceil(P×(from-1)/100)+1 ~ ceil(P×to/100). DB를 훑지 않는 산술 계산이다.
 * 마지막 보상 순위 뒤(구간 밖 하위권)는 공백으로 보지 않는다.
 * @param tiers 보상 구간 스냅샷
 * @param participants 제재 제외 참가자 수 P
 * @returns 공백 순위 범위 [시작, 끝] 목록 (없으면 빈 배열)
 * @author trisakion
 */
export function rewardGaps(tiers: RewardTier[], participants: number): [number, number][] {
    const P = participants;
    const ceilPct = (t: number) => Math.floor((P * t + 99) / 100);
    const spans = tiers
        .map((t): [number, number] => t.range_type === RangeType.RANK
            ? [Math.max(t.range_from, 1), Math.min(t.range_to, P)]
            : [ceilPct(Math.max(t.range_from, 1) - 1) + 1, Math.min(ceilPct(t.range_to), P)])
        .filter(([lo, hi]) => lo <= hi)
        .sort((a, b) => a[0] - b[0]);
    const gaps: [number, number][] = [];
    let next = 1;
    for (const [lo, hi] of spans) {
        if (lo > next)
            gaps.push([next, lo - 1]);
        next = Math.max(next, hi + 1);
    }
    return gaps;
}

/** 보상 공백을 이미 경고한 시즌 (프로세스당 한 번) */
const gapWarned = new Set<string>();

/**
 * 검수가 끝난 시즌을 확정하고 DELIVERING으로 넘긴다 (01_DESIGN 7.6). 커서는 메모리에만 두므로, 중단되면 다음 실행이
 * 제재 제외부터 다시 한 바퀴 돈다 — 각 단계가 멱등이라 결과가 같다.
 * 제재 제외·참가자 수 → 순위 재부여와 보상 판정(청크) → Top N 적재와 DELIVERING 전이(한 트랜잭션).
 * @param ctx 정산 락을 쥔 실행 문맥
 * @param t 대상 시즌 (REVIEW 또는 FINALIZING)
 * @returns 완료 Promise
 */
async function finalize(ctx: JobContext, t: SettleTarget): Promise<void> {
    const label = `ranking=${t.rankingId} season=${t.seasonNo}`;
    if (t.status === SeasonStatus.REVIEW) {
        const { result } = await callSp(ctx.conn, 'SP_START_FINALIZING', [t.rankingId, t.seasonNo]);
        // 목록을 읽은 뒤 GM이 보류를 걸었으면 1014다. 다음 주기에 목록에서 빠진다.
        if (result === SpResult.REVIEW_NOT_DUE)
            return;
        if (result !== SpResult.OK)
            throw new Error(`SP_START_FINALIZING result ${result} ${label}`);
        logger.info(`finalizing started ${label}`);
    }

    const started = Date.now();
    const ex = await callSp(ctx.conn, 'SP_UPDATE_FINAL_EXCLUSION', [t.rankingId, t.seasonNo]);
    if (ex.result !== SpResult.OK)
        throw new Error(`SP_UPDATE_FINAL_EXCLUSION result ${ex.result} ${label}`);
    // 의도한 공백일 수도 있어 막지 않고 알린다 (예: RANK 1~10위 + PERCENT 11%부터 → 11위~상위 10% 경계가 빈다)
    const snapshot = ex.rows[0].tier_snapshot;
    const gaps = rewardGaps(typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot, Number(ex.rows[0].participant_count));
    if (gaps.length && !gapWarned.has(label)) {
        gapWarned.add(label);
        logger.warn(`reward tiers leave ranks ${gaps.map(([a, b]) => `${a}..${b}`).join(', ')} without reward ${label}`);
    }
    let base = 0;
    for (;;) {
        await ctx.checkpoint();
        const chunk = await callSp(ctx.conn, 'SP_UPDATE_FINAL_RANK', [t.rankingId, t.seasonNo, base, config.scheduler.settleChunk]);
        if (chunk.result !== SpResult.OK)
            throw new Error(`SP_UPDATE_FINAL_RANK result ${chunk.result} ${label}`);
        const n = Number(chunk.rows[0].ranked_count);
        if (n === 0)
            break;
        base += n;
    }

    await ctx.checkpoint();
    const { result } = await callSp(ctx.conn, 'SP_UPDATE_SEASON_DELIVERING', [t.rankingId, t.seasonNo]);
    if (result !== SpResult.OK)
        throw new Error(`SP_UPDATE_SEASON_DELIVERING result ${result} ${label}`);
    logger.info(`final ranks done ${label} participants=${ex.rows[0].participant_count} in ${Date.now() - started}ms → DELIVERING`);
}

/**
 * 정산 잡을 시작한다 (01_DESIGN 7.1, 7.3, 7.6): settle_at이 지난 CLOSED 시즌을 SETTLING으로 바꾸고 가순위를 매겨 REVIEW로 넘기고,
 * 검수가 끝난 REVIEW 시즌을 확정해 DELIVERING으로 넘긴다.
 * 시즌 생성·상태 전이(스케줄러)와 따로 돈다 — 큰 시즌의 가순위가 길어도 시즌 생성이 밀리지 않는다.
 * Redis가 끊긴 동안은 건너뛴다. 시즌 키를 지우지 못한 채 넘어가면 키가 남아 메모리를 계속 차지한다.
 * @param pool 메인 DB 풀
 * @param redis Redis 클라이언트
 * @returns 정지 함수. DB 풀·Redis를 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 * @modified 2026-10-11 trisakion 확정(REVIEW → FINALIZING → DELIVERING) 추가
 */
export function startSettlement(pool: Pool, redis: Redis): () => Promise<void> {
    const stop = startJob(pool, { name: 'settlement', lock: SETTLE_LOCK, intervalMs: config.scheduler.intervalMs, ready: () => redis.isReady }, async (ctx) => {
        const { result, rows } = await callSp(ctx.conn, 'SP_LIST_SETTLE_TARGET', []);
        if (result !== SpResult.OK)
            throw new Error(`SP_LIST_SETTLE_TARGET result ${result}`);
        for (const r of rows) {
            const t: SettleTarget = { rankingId: r.ranking_id, seasonNo: r.season_no, status: r.status, settleAt: r.settle_at, dbNow: r.db_now };
            await ctx.checkpoint();
            if (t.status >= SeasonStatus.REVIEW) {
                await finalize(ctx, t);
                continue;
            }
            if (t.status === SeasonStatus.CLOSED && !await startSettling(pool, t))
                continue;
            await provisionalRank(pool, ctx, redis, t);
        }
    });
    logger.info(`settlement started (interval ${config.scheduler.intervalMs}ms, chunk ${config.scheduler.settleChunk})`);
    return stop;
}
