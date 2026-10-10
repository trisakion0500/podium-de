import type { Pool, RowDataPacket } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { applyMode, composite, getRanking, type RankingRule } from '../core/rankings.js';
import {
    clearRebuild, countBoard, finishRebuild, markSynced, readComposites, readSentinel, reconcileScore,
    seasonKeys, writeRebuild, type Redis, type SeasonKeys,
} from '../core/redis.js';
import { startJob, type JobContext } from './loop.js';

/** 복구 잡 락. 정산의 시즌 키 삭제도 이 락을 잡는다 — 재구축이 삭제 뒤에 센티넬을 되살리지 않게 한다 (D-60) */
export const RECOVERY_LOCK = 'podium:recovery';

/** 보조 점검 주기 (01_DESIGN 6.4). 하루보다 짧은 시즌도 여러 번 점검되게 1시간으로 둔다 — 점검은 COUNT 한 번이라 가볍다 */
// ponytail: 고정 1시간. 시즌이 1시간보다 짧은 랭킹이 생기면 min(1시간, 시즌 길이 ÷ 4)처럼 시즌 길이에 맞춘다.
const AUDIT_INTERVAL_MS = 3_600_000;

/** SP_LIST_RECOVERY_SEASON 행 */
interface RecoverySeason {
    rankingId: number;
    seasonNo: number;
    startAt: Date;
    /** 동기화 시각: 리컨실러가 이 시각까지 바뀐 행을 Redis에 맞췄다 (job_state.synced_at) */
    syncedAt: Date | null;
    auditAt: Date | null;
    /** 이번 주기 스캔 시작 DB 시각 T */
    dbNow: Date;
}

/**
 * 한 주기의 실행 문맥. 락을 쥔 전용 커넥션으로 마스터에서 읽는다(6.2).
 */
interface Context extends JobContext {
    redis: Redis;
}

/**
 * MySQL 행을 Redis에 쓸 값으로 바꾼다. composite를 계산할 수 없는 행(정의 데이터 이상)은 로그를 남기고 건너뛴다 —
 * 한 행 때문에 시즌 전체 복구가 멈추지 않게 한다. 정상이라면 등록 시 비트 예산 검증(2.4)이 막는다.
 * @param rule 랭킹 정의
 * @param season 시즌
 * @param rows SP 행 (member_id, score, achieved_at, version)
 * @returns 멤버, composite, version
 */
function toItems(rule: RankingRule, season: RecoverySeason, rows: RowDataPacket[]): { memberId: string; composite: number; version: number }[] {
    const items = [];
    for (const r of rows) {
        try {
            items.push({ memberId: r.member_id as string, composite: composite(rule, Number(r.score), r.achieved_at, season.startAt), version: r.version as number });
        } catch (err) {
            logger.error(`recovery skipped member ranking=${season.rankingId} season=${season.seasonNo} member=${r.member_id}`, err);
        }
    }
    return items;
}

/**
 * 변경분을 (updated_at, member_id) 키셋 청크로 읽는다 (SP_LIST_RANKING_ENTRY_CHANGED).
 * @param ctx 실행 문맥
 * @param season 시즌
 * @param since 이 시각 이후 (동기화 시각 − 안전마진)
 * @returns 청크 단위 행
 */
async function* scanChanged(ctx: Context, season: RecoverySeason, since: Date): AsyncGenerator<RowDataPacket[]> {
    let afterAt = since;
    let afterMember = '';
    for (;;) {
        await ctx.checkpoint();
        const { result, rows } = await callSp(ctx.conn, 'SP_LIST_RANKING_ENTRY_CHANGED', [season.rankingId, season.seasonNo, afterAt, afterMember, config.recovery.chunk]);
        if (result !== SpResult.OK)
            throw new Error(`SP_LIST_RANKING_ENTRY_CHANGED result ${result}`);
        if (rows.length === 0)
            return;
        yield rows;
        const last = rows[rows.length - 1];
        afterAt = last.updated_at;
        afterMember = last.member_id;
        if (rows.length < config.recovery.chunk)
            return;
    }
}

/**
 * 동기화 시각에서 안전마진만큼 뒤로 간 스캔 시작 시각. 동기화 시각이 없으면 처음부터 읽는다.
 * @param syncedAt 동기화 시각
 * @returns 스캔 시작 시각
 */
function scanFrom(syncedAt: Date | null): Date {
    return new Date((syncedAt?.getTime() ?? 0) - config.recovery.marginSec * 1000);
}

/**
 * L2 스캔 시작 시각. DB 동기화 시각과 센티넬 값 중 이른 쪽이다 — Redis가 스냅샷 복원·페일오버로 과거로 돌아갔으면 센티넬 값이 더 이르다.
 * @param season 시즌
 * @param redisSyncedAt 센티넬 값 (Redis가 따라잡은 시각 ms)
 * @returns 스캔 시작 시각 (안전마진 빼기 전)
 */
function reconcileFrom(season: RecoverySeason, redisSyncedAt: number): Date {
    if (season.syncedAt && season.syncedAt.getTime() <= redisSyncedAt)
        return season.syncedAt;
    if (season.syncedAt)
        logger.warn(`reconcile from redis sentinel ${new Date(redisSyncedAt).toISOString()} (behind db synced_at — redis restored or failed over?) ranking=${season.rankingId} season=${season.seasonNo}`);
    return new Date(redisSyncedAt);
}

/**
 * L2 차분 반영 (01_DESIGN 6.2). 변경분 중 Redis 값과 다른 것만 센티넬 확인 Lua로 다시 쓴다.
 * 끝까지 돌면 DB 동기화 시각과 센티넬 값을 이번 주기 시작 DB 시각 T로 옮긴다. 중간에 센티넬이 사라지면(정산, Redis 유실) 멈추고 둘 다 두지 않는다.
 * @param ctx 실행 문맥
 * @param season 시즌
 * @param rule 랭킹 정의
 * @param keys 시즌 키
 * @param from 이 시각 이후 변경분부터 (안전마진은 여기서 뺀다. epoch면 시즌 전체)
 * @returns 완료 Promise
 */
async function reconcile(ctx: Context, season: RecoverySeason, rule: RankingRule, keys: SeasonKeys, from: Date): Promise<void> {
    const mode = applyMode(rule);
    let scanned = 0;
    let fixed = 0;
    for await (const rows of scanChanged(ctx, season, scanFrom(from))) {
        scanned += rows.length;
        const items = toItems(rule, season, rows);
        if (items.length === 0)
            continue;
        const current = await readComposites(ctx.redis, keys.board, items.map((i) => i.memberId));
        const stale = items.filter((item, i) => current[i] !== item.composite);
        const results = await Promise.all(stale.map((item) => reconcileScore(ctx.redis, keys, {
            rankingId: season.rankingId, seasonNo: season.seasonNo, ...item, ...mode,
        })));
        if (results.includes(-1)) {
            logger.info(`reconcile stopped: sentinel gone ranking=${season.rankingId} season=${season.seasonNo}`);
            return;
        }
        fixed += results.filter((r) => r > 0).length;
    }
    await markSynced(ctx.redis, keys, season.dbNow);
    await saveJobState(ctx, 'reconciler', season, season.dbNow);
    if (fixed > 0)
        logger.info(`reconciled ranking=${season.rankingId} season=${season.seasonNo} fixed=${fixed} scanned=${scanned}`);
}

/**
 * L3 재구축 (01_DESIGN 6.3). 임시 키에 시즌 전체를 적재하고, 시작 시각 T부터 바뀐 행을 따라잡은 뒤 한 번에 교체한다.
 * 새로 열린 빈 시즌도 여기로 와서 센티넬만 세운다(D-60). 동기화 시각은 T로 둔다 — 따라잡기 뒤 교체 전에 바뀐 행은
 * 다음 L2가 T − 안전마진부터 다시 읽는다. 교체 직전 임시 ZSET이 적재 수보다 작으면(도중 Redis 재시작·페일오버) 교체하지 않고
 * 실패로 끝낸다 — 센티넬이 없으므로 다음 주기가 처음부터 다시 재구축한다.
 * @param ctx 실행 문맥
 * @param season 시즌
 * @param rule 랭킹 정의
 * @param keys 시즌 키
 * @returns 완료 Promise
 */
async function rebuild(ctx: Context, season: RecoverySeason, rule: RankingRule, keys: SeasonKeys): Promise<void> {
    const started = Date.now();
    const withVersion = !applyMode(rule).best;
    // 이전에 중단된 재구축이 남긴 임시 키 위에 쌓으면 그 사이 제외된 멤버가 섞인다.
    // ponytail: 임시 키 이름이 시즌마다 하나라, 락을 잃은 워커가 청크를 읽은 직후 멈췄다가 늦게 쓰면 이어받은 워커의 임시 키에
    // 옛 값이 섞일 수 있다(그 멤버가 따라잡기 구간 밖에서 바뀐 경우만). 락 상실 직후 수 ms 창이라 감수한다. 실제로 겪으면
    // 임시 키에 실행 ID를 붙이고 TTL을 건다.
    await clearRebuild(ctx.redis, keys);

    let loaded = 0;
    let after = '';
    for (;;) {
        await ctx.checkpoint();
        const { result, rows } = await callSp(ctx.conn, 'SP_LIST_RANKING_ENTRY_CHUNK', [season.rankingId, season.seasonNo, after, config.recovery.chunk]);
        if (result !== SpResult.OK)
            throw new Error(`SP_LIST_RANKING_ENTRY_CHUNK result ${result}`);
        if (rows.length === 0)
            break;
        const items = toItems(rule, season, rows);
        await writeRebuild(ctx.redis, keys, items, withVersion);
        loaded += items.length;
        after = rows[rows.length - 1].member_id;
        if (rows.length < config.recovery.chunk)
            break;
    }

    for await (const rows of scanChanged(ctx, season, scanFrom(season.dbNow)))
        await writeRebuild(ctx.redis, keys, toItems(rule, season, rows), withVersion);

    await ctx.checkpoint();
    if (!await finishRebuild(ctx.redis, keys, season.dbNow, loaded))
        throw new Error(`rebuild aborted: temp keys lost members (redis restarted or failed over?) ranking=${season.rankingId} season=${season.seasonNo} loaded=${loaded}`);
    await saveJobState(ctx, 'reconciler', season, season.dbNow);
    // 방금 MySQL 기준으로 만들었으니 점검 시계를 여기서 시작한다. 새 시즌을 빈 채로 바로 점검하지 않는다.
    await saveJobState(ctx, 'recovery_audit', season, null);
    logger.info(`rebuilt ranking=${season.rankingId} season=${season.seasonNo} members=${loaded} in ${Date.now() - started}ms`);
}

/**
 * 보조 점검 (01_DESIGN 6.4). MySQL 수를 먼저 센다 — 그 뒤 들어온 멤버는 ZCARD만 늘리므로, ZCARD가 더 작을 때만 빠진 것이다.
 * 빠졌으면 시즌 전체를 L2로 다시 훑어 채운다. 센티넬을 지워 재구축하지 않는 것은 그동안 조회가 2007로 막히고, composite를
 * 계산할 수 없는 행이 있으면 재구축해도 다시 빠져 매일 반복되기 때문이다.
 * @param ctx 실행 문맥
 * @param season 시즌
 * @param rule 랭킹 정의
 * @param keys 시즌 키
 * @returns 완료 Promise
 * @modified 2026-10-09 trisakion 불일치 시 센티넬 삭제 대신 L2 전체 스캔
 */
async function audit(ctx: Context, season: RecoverySeason, rule: RankingRule, keys: SeasonKeys): Promise<void> {
    const { result, rows } = await callSp(ctx.conn, 'SP_COUNT_RANKING_ENTRY', [season.rankingId, season.seasonNo]);
    if (result !== SpResult.OK)
        throw new Error(`SP_COUNT_RANKING_ENTRY result ${result}`);
    const mysqlCount = Number(rows[0].entry_count);
    const redisCount = await countBoard(ctx.redis, keys);
    if (redisCount < mysqlCount) {
        logger.warn(`recovery audit mismatch ranking=${season.rankingId} season=${season.seasonNo} redis=${redisCount} mysql=${mysqlCount} — full reconcile`);
        await reconcile(ctx, season, rule, keys, new Date(0));
    }
    await saveJobState(ctx, 'recovery_audit', season, null);
}

/**
 * job_state에 진행 상태를 남긴다 (SP_UPSERT_JOB_STATE).
 * @param ctx 실행 문맥
 * @param job 잡 이름
 * @param season 시즌
 * @param syncedAt 동기화 시각 (null: 남기지 않음)
 * @returns 완료 Promise
 */
async function saveJobState(ctx: Context, job: string, season: RecoverySeason, syncedAt: Date | null): Promise<void> {
    const { result } = await callSp(ctx.conn, 'SP_UPSERT_JOB_STATE', [job, season.rankingId, season.seasonNo, syncedAt]);
    if (result !== SpResult.OK)
        throw new Error(`SP_UPSERT_JOB_STATE result ${result}`);
}

/**
 * 한 주기: 대상 시즌마다 센티넬이 없으면 재구축, 있으면 L2, 1시간이 지났으면 보조 점검.
 * @param ctx 실행 문맥
 * @returns 완료 Promise
 */
async function runCycle(ctx: Context): Promise<void> {
    const { result, rows } = await callSp(ctx.conn, 'SP_LIST_RECOVERY_SEASON', []);
    if (result !== SpResult.OK)
        throw new Error(`SP_LIST_RECOVERY_SEASON result ${result}`);
    // ponytail: 한 시즌이 실패하면 이번 주기의 나머지 시즌도 건너뛴다. 특정 시즌이 계속 실패해 다른 시즌을 막으면 시즌별 격리로 바꾼다.
    for (const r of rows) {
        const season: RecoverySeason = {
            rankingId: r.ranking_id, seasonNo: r.season_no, startAt: r.start_at,
            syncedAt: r.synced_at, auditAt: r.audit_at, dbNow: r.db_now,
        };
        const rule = getRanking(season.rankingId);
        if (!rule) {
            // 새로 등록한 랭킹은 정의 재조회(최대 30초) 뒤에 보인다.
            logger.debug(`recovery skipped ranking=${season.rankingId}: definition not loaded yet`);
            continue;
        }
        const keys = seasonKeys(season.rankingId, season.seasonNo);
        await ctx.checkpoint();
        const redisSyncedAt = await readSentinel(ctx.redis, keys);
        if (redisSyncedAt === null) {
            await rebuild(ctx, season, rule, keys);
            continue;
        }
        await reconcile(ctx, season, rule, keys, reconcileFrom(season, redisSyncedAt));
        if (!season.auditAt || season.dbNow.getTime() - season.auditAt.getTime() >= AUDIT_INTERVAL_MS)
            await audit(ctx, season, rule, keys);
    }
}

/**
 * 복구 잡을 시작한다 (01_DESIGN 6.2~6.4). 주기마다 GET_LOCK을 시도해 워커 여러 대 중 한 곳에서만 돈다.
 * Redis가 끊긴 동안은 건너뛴다 — 연결 상태 로그는 redis.ts가 남긴다.
 * @param pool 메인 DB 풀
 * @param redis Redis 클라이언트
 * @returns 정지 함수. 진행 중인 주기가 청크 경계에서 멈출 때까지 기다린다. DB 풀·Redis를 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 * @modified 2026-10-10 trisakion 주기 루프를 loop.startJob으로 분리 (스케줄러와 공유)
 */
export function startRecovery(pool: Pool, redis: Redis): () => Promise<void> {
    const stop = startJob(pool, { name: 'recovery', lock: RECOVERY_LOCK, intervalMs: config.recovery.intervalMs, ready: () => redis.isReady },
        (ctx) => runCycle({ ...ctx, redis }));
    logger.info(`recovery started (interval ${config.recovery.intervalMs}ms, margin ${config.recovery.marginSec}s)`);
    return stop;
}
