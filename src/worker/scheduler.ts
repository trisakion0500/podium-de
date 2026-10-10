import type { Pool } from 'mysql2/promise';
import { CycleType, SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob, type JobContext } from './loop.js';

/** 스케줄러 락. 시즌 생성과 상태 전이는 워커 한 곳에서만 한다 */
export const SCHEDULE_LOCK = 'podium:schedule';

/** 미리 유지할 끝나지 않은 시즌 수: 현재 + 다음 2개. 짧은 주기에서도 파티션 수(상한 8192)가 늘지 않게 개수로 둔다 */
const AHEAD_SEASONS = 3;

/** 시즌 행과 파티션이 있어야 하는 시작 전 여유 (D-60). 복구 잡이 이때부터 센티넬을 세운다 */
const READY_LEAD_MS = 60_000;

/** MONTHLY 시즌 시작일 상한. 모든 달에 있는 날까지만 허용해 말일 붙임으로 일정이 밀리지 않게 한다 (D-67) */
const MONTHLY_MAX_START_DAY = 28;

/** 영구 랭킹(반복 없음, 종료 없음) 시즌의 end_at. ranking_season.end_at은 NULL을 받지 않는다 */
const PERMANENT_END = new Date('9999-12-31T00:00:00.000Z');

/**
 * 시즌 계산에 쓰는 랭킹 정의 값 (ranking_definition)
 * @author trisakion
 */
export interface SeasonCycle {
    /** 달력 경계 계산 기준 시간대 (IANA, 예: Asia/Seoul) */
    timezone: string;
    /** 랭킹 시작 시각. 시즌 1의 시작이자 WEEKLY의 요일 기준이다 */
    startAt: Date;
    /** 랭킹 종료 시각 (null: 없음). 이 시각까지만 시즌을 만들고 마지막 시즌은 여기서 자른다 */
    endAt: Date | null;
    /** 시즌 주기 (codes.CycleType) */
    cycleType: number;
    /** FIXED 길이(초) */
    cycleValue: number | null;
    /** 시즌 종료 → 다음 시즌 시작 대기(초) */
    waitPeriod: number;
}

/**
 * 시즌 하나의 번호와 기간 [startAt, endAt)
 * @author trisakion
 */
export interface SeasonSpan {
    seasonNo: number;
    startAt: Date;
    endAt: Date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** 이미 남긴 시즌 계산 오류 (랭킹:메시지) */
const planErrors = new Set<string>();

/**
 * UTC 시각을 그 시간대의 벽시계 시각으로 바꾼다. 결과는 벽시계 값을 UTC 필드에 담은 ms다(계산용).
 * @param ms UTC 시각 ms
 * @param timezone IANA 시간대 (잘못된 이름이면 RangeError)
 * @returns 벽시계 ms
 */
function wallClock(ms: number, timezone: string): number {
    let fmt = formatters.get(timezone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatters.set(timezone, fmt);
    }
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((ms % 1000) + 1000) % 1000);
}

/**
 * 벽시계 시각을 UTC로 되돌린다. 오프셋이 그 시각에 따라 달라지므로(DST) 한 번 더 맞춘다.
 * @param wall 벽시계 ms (wallClock 형식)
 * @param timezone IANA 시간대
 * @returns UTC ms
 */
function fromWallClock(wall: number, timezone: string): number {
    // ponytail: DST로 건너뛰는 시각(존재하지 않는 벽시계)은 앞뒤 한쪽으로 붙는다. 경계는 보통 자정이라 영향이 없다.
    const guess = wall - (wallClock(wall, timezone) - wall);
    return wall - (wallClock(guess, timezone) - guess);
}

/**
 * 시즌 시작에서 달력 한 주기 뒤를 구한다. 벽시계 기준으로 더하므로 DST가 바뀌는 날도 같은 시각(예: 자정)에서 끊긴다.
 * @param start 시즌 시작
 * @param timezone IANA 시간대
 * @param cycleType DAILY, WEEKLY, MONTHLY
 * @returns 시즌 종료
 */
function addCalendar(start: Date, timezone: string, cycleType: number): Date {
    const w = new Date(wallClock(start.getTime(), timezone));
    if (cycleType === CycleType.DAILY)
        w.setUTCDate(w.getUTCDate() + 1);
    else if (cycleType === CycleType.WEEKLY)
        w.setUTCDate(w.getUTCDate() + 7);
    else {
        // 다음 달에 같은 날이 없으면(31일 → 2월) 그달 마지막 날로 붙인다. 시즌이 이어지는 경우는 nextSeason이 29일 이후 시작을
        // 막으므로, 여기서 붙이는 것은 마지막 시즌(랭킹 end_at에서 잘림)뿐이다.
        const day = w.getUTCDate();
        w.setUTCDate(1);
        w.setUTCMonth(w.getUTCMonth() + 1);
        w.setUTCDate(Math.min(day, new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() + 1, 0)).getUTCDate()));
    }
    return new Date(fromWallClock(w.getTime(), timezone));
}

/**
 * 다음 시즌을 계산한다 (01_DESIGN 2.5, 3.2). 시즌 1은 랭킹 시작에서 시작하고, 이후 시즌은 앞 시즌 종료 + wait_period에서 시작한다.
 * 시즌 길이는 DAILY·WEEKLY·MONTHLY가 timezone 벽시계로 하루·7일·한 달, FIXED가 cycle_value초다. WEEKLY의 요일은 시작 시각의 요일이다.
 * 랭킹 종료가 있으면 그 시각에서 자르고, 그 뒤에 시작하는 시즌은 만들지 않는다.
 * MONTHLY에서 timezone 기준 시작일이 28일을 넘는 시즌이 마지막 시즌이 아니면(다음 시즌이 이어지면) 예외로 막는다(D-67).
 * 다음 달에 같은 날이 없어 말일로 붙으면 그 뒤 시즌이 모두 그 날로 밀려(1/31 → 2/28 → 3/28) 운영자가 의도한 일정과 달라진다.
 * @param cycle 랭킹 주기 설정
 * @param last 마지막 시즌 (null: 아직 없음)
 * @returns 다음 시즌 (null: 더 만들 시즌 없음 — 반복 없는 랭킹이거나 랭킹 종료 이후)
 * @author trisakion
 * @modified 2026-10-10 trisakion MONTHLY 29일 이후 시작이 이어지는 시즌이면 거부 (D-67)
 * @modified 2026-10-10 trisakion FIXED cycle_value 1 미만 거부 (길이 0 시즌 방지)
 */
export function nextSeason(cycle: SeasonCycle, last: SeasonSpan | null): SeasonSpan | null {
    if (last && cycle.cycleType === CycleType.NONE)
        return null;
    const seasonNo = last ? last.seasonNo + 1 : 1;
    const startAt = last ? new Date(last.endAt.getTime() + cycle.waitPeriod * 1000) : cycle.startAt;
    if (cycle.endAt && startAt >= cycle.endAt)
        return null;

    let endAt: Date;
    if (cycle.cycleType === CycleType.NONE)
        endAt = cycle.endAt ?? PERMANENT_END;
    else if (cycle.cycleType === CycleType.FIXED) {
        if (!cycle.cycleValue || cycle.cycleValue < 1)
            throw new Error(`FIXED cycle_value must be >= 1 (got ${cycle.cycleValue})`);
        endAt = new Date(startAt.getTime() + cycle.cycleValue * 1000);
    }
    else if (cycle.cycleType === CycleType.DAILY || cycle.cycleType === CycleType.WEEKLY || cycle.cycleType === CycleType.MONTHLY)
        endAt = addCalendar(startAt, cycle.timezone, cycle.cycleType);
    else
        throw new Error(`unsupported cycle_type ${cycle.cycleType}`);
    const isLast = cycle.endAt !== null && endAt >= cycle.endAt;
    if (cycle.cycleType === CycleType.MONTHLY && !isLast && new Date(wallClock(startAt.getTime(), cycle.timezone)).getUTCDate() > MONTHLY_MAX_START_DAY)
        throw new Error(`MONTHLY season ${seasonNo} starts after day ${MONTHLY_MAX_START_DAY} (${startAt.toISOString()} ${cycle.timezone}) and more seasons follow — set start_at day to 1~${MONTHLY_MAX_START_DAY} (D-67)`);
    if (isLast)
        endAt = cycle.endAt as Date;
    return { seasonNo, startAt, endAt };
}

/**
 * 두 파티션 테이블에 시즌 파티션을 추가한다 (SP_PARTITION_ADD, 이미 있으면 건너뜀).
 * @param ctx 실행 문맥
 * @param rankingId 랭킹 ID
 * @param seasonNo 시즌 번호
 * @returns 완료 Promise
 */
async function addPartition(ctx: JobContext, rankingId: number, seasonNo: number): Promise<void> {
    const { result } = await callSp(ctx.conn, 'SP_PARTITION_ADD', [rankingId, seasonNo]);
    if (result !== SpResult.OK)
        throw new Error(`SP_PARTITION_ADD result ${result} ranking=${rankingId} season=${seasonNo}`);
}

/**
 * 시각이 지난 시즌의 상태를 바꾼다 (SCHEDULED→OPEN, →CLOSED).
 * @param ctx 실행 문맥
 * @returns 완료 Promise
 */
async function advanceStatus(ctx: JobContext): Promise<void> {
    const { result, rows } = await callSp(ctx.conn, 'SP_ADVANCE_SEASON_STATUS', []);
    if (result !== SpResult.OK)
        throw new Error(`SP_ADVANCE_SEASON_STATUS result ${result}`);
    const { closed_count: closed, opened_count: opened } = rows[0];
    if (closed > 0 || opened > 0)
        logger.info(`seasons advanced opened=${opened} closed=${closed}`);
}

/**
 * 한 랭킹의 시즌 계산·추가 실패를 남긴다. 정의 데이터 이상은 고칠 때까지 매 주기 같은 오류가 나므로 같은 내용은 프로세스당 한 번만 남긴다.
 * 이 랭킹만 건너뛰고 다른 랭킹은 계속 만든다 — 정의 하나 때문에 모든 랭킹의 시즌 생성이 멈추지 않게 한다.
 * @param rankingId 랭킹 ID
 * @param err 오류
 * @returns 없음
 */
function reportPlanError(rankingId: number, err: Error): void {
    const key = `${rankingId}:${err.message}`;
    if (planErrors.has(key))
        return;
    planErrors.add(key);
    logger.error(`season plan skipped ranking=${rankingId}`, err);
}

/**
 * 랭킹마다 끝나지 않은 시즌이 3개가 되도록 시즌 행과 파티션을 만든다 (01_DESIGN 3.3).
 * 워커가 오래 멈췄다 돌아오면 지나간 시즌도 번호를 이어 만든다 — 시즌 번호가 달력 주기와 맞아야 게임 서버가 계산한 번호와 같다.
 * 지나간 시즌은 행만 만들고 파티션은 만들지 않는다. 다음 상태 전이에서 바로 CLOSED가 되고 빈 채로 정산된다.
 * 개수 제한은 두지 않는다 — 과거 start_at 같은 등록 실수는 등록 검증(6단계)과 등록한 사람의 몫이다(D-63).
 * @param ctx 실행 문맥
 * @returns 완료 Promise
 */
async function extendSeasons(ctx: JobContext): Promise<void> {
    const { result, rows } = await callSp(ctx.conn, 'SP_LIST_SEASON_PLAN', []);
    if (result !== SpResult.OK)
        throw new Error(`SP_LIST_SEASON_PLAN result ${result}`);
    for (const r of rows) {
        const rankingId: number = r.ranking_id;
        const cycle: SeasonCycle = {
            timezone: r.timezone, startAt: r.start_at, endAt: r.end_at, cycleType: r.cycle_type, cycleValue: r.cycle_value, waitPeriod: r.wait_period,
        };
        let last: SeasonSpan | null = r.last_season_no ? { seasonNo: r.last_season_no, startAt: r.last_start_at, endAt: r.last_end_at } : null;
        let ahead = Number(r.ahead_count);
        while (ahead < AHEAD_SEASONS) {
            let next: SeasonSpan | null;
            try {
                next = nextSeason(cycle, last);
            } catch (err) {
                reportPlanError(rankingId, err as Error);
                break;
            }
            if (!next)
                break;
            await ctx.checkpoint();
            const { result: inserted } = await callSp(ctx.conn, 'SP_INSERT_SEASON', [rankingId, next.seasonNo, next.startAt, next.endAt]);
            if (inserted !== SpResult.OK) {
                // 정의나 기존 시즌 행이 계산과 맞지 않는다(예: 시작이 앞 시즌 종료보다 이름). DB 오류(50001)는 예외로 와서 주기를 다시 돈다.
                reportPlanError(rankingId, new Error(`SP_INSERT_SEASON result ${inserted} season=${next.seasonNo}`));
                break;
            }
            // 이미 끝난 시즌은 제출이 시각 검사로 막혀 행이 들어올 수 없다. 빈 파티션은 공유 테이블의 파티션 상한(8192)과
            // DDL만 늘리므로 만들지 않는다 — 정산과 아카이브는 파티션 없는 시즌을 빈 시즌으로 처리한다.
            const past = next.endAt <= r.db_now;
            if (!past)
                await addPartition(ctx, rankingId, next.seasonNo);
            logger.info(`season created ranking=${rankingId} season=${next.seasonNo} ${next.startAt.toISOString()} ~ ${next.endAt.toISOString()}${past ? ' (already ended, no partition)' : ''}`);
            if (!past)
                ahead++;
            last = next;
        }
    }
}

/**
 * 시즌 행은 있는데 파티션이 빠진 시즌을 채운다. 시즌 INSERT와 파티션 DDL 사이에 워커가 죽은 경우다.
 * @param ctx 실행 문맥
 * @returns 완료 Promise
 */
async function fillPartitions(ctx: JobContext): Promise<void> {
    const { result, rows } = await callSp(ctx.conn, 'SP_LIST_SEASON_PARTITION_MISSING', []);
    if (result !== SpResult.OK)
        throw new Error(`SP_LIST_SEASON_PARTITION_MISSING result ${result}`);
    for (const r of rows) {
        // 시작 60초 안쪽인데 아직 없으면 순위표 준비(D-60)와 제출이 늦어진다. DDL이 계속 실패하는지 확인하게 알린다.
        if ((r.start_at as Date).getTime() - Date.now() < READY_LEAD_MS)
            logger.warn(`season partition missing near start ranking=${r.ranking_id} season=${r.season_no} start=${(r.start_at as Date).toISOString()}`);
        await ctx.checkpoint();
        await addPartition(ctx, r.ranking_id, r.season_no);
    }
}

/**
 * 시즌 스케줄러를 시작한다 (01_DESIGN 3.3, 3.5): 상태 전이 → 시즌 선행 생성 → 빠진 파티션 채우기.
 * 상태 전이를 먼저 하는 것은 시각에 가장 민감해서다. 정산(SETTLING 이후)은 settle.ts의 정산 잡이 따로 한다.
 * @param pool 메인 DB 풀
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startScheduler(pool: Pool): () => Promise<void> {
    const stop = startJob(pool, { name: 'scheduler', lock: SCHEDULE_LOCK, intervalMs: config.scheduler.intervalMs }, async (ctx) => {
        await advanceStatus(ctx);
        await extendSeasons(ctx);
        await fillPartitions(ctx);
    });
    logger.info(`scheduler started (interval ${config.scheduler.intervalMs}ms)`);
    return stop;
}
