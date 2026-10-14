import type { Pool, PoolConnection } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob } from './loop.js';

/** 로그 정리 잡 락 (메인 DB). 워커 여러 대 중 한 곳에서만 돈다 */
const LOG_CLEANUP_LOCK = 'podium:log-cleanup';

/** 주기. 하루 한 번이면 되지만, 실패나 워커 정지 뒤에 하루를 기다리지 않고 따라잡도록 1시간마다 본다. 할 일이 없으면 SP 두 번뿐이다 */
const INTERVAL_MS = 3_600_000;

/** 일 파티션을 오늘부터 며칠 뒤까지 미리 만들지. 잡이 이 기간 안에 다시 돌면 p_max에 행이 쌓이지 않는다 */
const AHEAD_DAYS = 7;

/** 정체 감시 락. 정리 잡과 락을 나눠, 정리 주기가 멈춰도 감시는 돈다 */
const WATCH_LOCK = 'podium:log-cleanup-watch';

/** 감시 주기 */
const WATCH_INTERVAL_MS = 600_000;

/** 마지막 성공 후 이만큼 지나면 정체로 본다. 정리 주기의 3배 — 한두 번의 실패는 다음 주기가 따라잡는다 */
const STALL_SEC = 3 * 3600;

/**
 * 로그 정리 한 번의 결과
 * @author trisakion
 */
export interface LogCleanupResult {
    added: number;
    dropped: number;
    /** 재구성 전 p_max에 행이 있었는지 — 그날 파티션을 제때 만들지 못한 것이다 (01_DESIGN 11.4) */
    pmaxHadRows: boolean;
}

/**
 * UTC 기준 오늘에서 days일 떨어진 날짜를 'YYYY-MM-DD'로 만든다.
 * @param days 오늘 기준 일수 (음수: 과거)
 * @returns 날짜 문자열
 */
function utcDay(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 로그 DB 제출 이력의 일 파티션을 정리한다 (01_DESIGN 4.5): 오늘 + AHEAD_DAYS까지 만들고, 보관 기간이 지난 것을 지운다.
 * SP는 호출당 개수 제한이 있어(64·31개) 0이 나올 때까지 다시 부른다 — 오래 멈췄다 재개한 경우다.
 * @param logPool 로그 DB 풀
 * @param retentionDays 보관 일수 (LOG_RETENTION_DAYS)
 * @param checkpoint SP 호출 사이마다 부른다. 락을 잃었거나 종료 중이면 예외로 멈춘다
 * @returns 만든·지운 파티션 수와 p_max 행 여부
 * @author trisakion
 */
export async function cleanupLogPartitions(logPool: Pool, retentionDays: number, checkpoint: () => Promise<void> = async () => {}): Promise<LogCleanupResult> {
    const out: LogCleanupResult = { added: 0, dropped: 0, pmaxHadRows: false };
    for (let first = true; ; first = false) {
        const { result, rows } = await callSp(logPool, 'SP_LOG_PARTITION_ADD', [utcDay(AHEAD_DAYS)]);
        if (result !== SpResult.OK)
            throw new Error(`SP_LOG_PARTITION_ADD result ${result}`);
        // 첫 호출만 본다. 그 뒤 호출은 앞 호출이 옮기지 못한(아직 파티션이 없는 날의) 행을 다시 보는 것이다
        if (first)
            out.pmaxHadRows = rows[0].pmax_had_rows === 1;
        out.added += rows[0].added_count;
        if (rows[0].added_count === 0)
            break;
        await checkpoint();
    }
    for (;;) {
        const { result, rows } = await callSp(logPool, 'SP_LOG_PARTITION_DROP', [utcDay(-retentionDays)]);
        if (result !== SpResult.OK)
            throw new Error(`SP_LOG_PARTITION_DROP result ${result}`);
        out.dropped += rows[0].dropped_count;
        if (rows[0].dropped_count === 0)
            break;
        await checkpoint();
    }
    return out;
}

/**
 * 로그 정리 잡을 시작한다 (01_DESIGN 4.5, 11.4). 락은 메인 DB에서 잡고 SP는 로그 DB 풀로 부른다.
 * 성공하면 job_state('log_cleanup')의 last_run_at을 남긴다 — 잡이 멈췄는지 밖에서 볼 수 있게 한다.
 * @param pool 메인 DB 풀
 * @param logPool 로그 DB 풀
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startLogCleanup(pool: Pool, logPool: Pool): () => Promise<void> {
    const stop = startJob(pool, { name: 'log cleanup', lock: LOG_CLEANUP_LOCK, intervalMs: INTERVAL_MS }, async (ctx) => {
        const r = await cleanupLogPartitions(logPool, config.logRetentionDays, ctx.checkpoint);
        if (r.pmaxHadRows)
            logger.warn('log_ranking_submit p_max had rows — day partitions were not created in time (log cleanup stopped?)');
        if (r.added > 0 || r.dropped > 0)
            logger.info(`log partitions added=${r.added} dropped=${r.dropped}`);
        const { result } = await callSp(ctx.conn, 'SP_UPSERT_JOB_STATE', ['log_cleanup', 0, 0, null]);
        if (result !== SpResult.OK)
            throw new Error(`SP_UPSERT_JOB_STATE result ${result}`);
    });
    logger.info(`log cleanup started (retention ${config.logRetentionDays} days)`);
    return stop;
}

/**
 * 로그 정리 잡이 정체됐는지 본다 (01_DESIGN 11.4). 마지막 성공(job_state.last_run_at)이 STALL_SEC보다 오래면 정체다.
 * 한 번도 성공하지 않았으면(행 없음) 이 프로세스가 STALL_SEC보다 오래 떠 있을 때만 정체로 본다 — 설치 직후 첫 주기 전에 경고하지 않게 한다.
 * @param conn 메인 DB 커넥션
 * @param uptimeSec 프로세스 가동 초 (테스트에서 바꾼다)
 * @returns 정체 여부와 마지막 성공 후 지난 초 (null: 성공 기록 없음)
 * @author trisakion
 */
export async function checkLogCleanupStall(conn: PoolConnection | Pool, uptimeSec = process.uptime()): Promise<{ stalled: boolean; ageSec: number | null }> {
    const { result, rows } = await callSp(conn, 'SP_GET_JOB_STATE_AGE', ['log_cleanup', 0, 0]);
    if (result !== SpResult.OK)
        throw new Error(`SP_GET_JOB_STATE_AGE result ${result}`);
    const ageSec: number | null = rows[0].age_sec === null ? null : Number(rows[0].age_sec);
    return { stalled: ageSec === null ? uptimeSec > STALL_SEC : ageSec > STALL_SEC, ageSec };
}

/**
 * 로그 정리 정체 감시를 시작한다. 정리 잡 자신은 멈추면 경고도 못 남기므로 따로 돈다.
 * 정체가 시작될 때 한 번 경고하고, 풀리면 한 번 알린다 — 10분마다 같은 경고를 반복하지 않는다.
 * 워커 프로세스 전체가 멈춘 경우는 이 감시도 멈추므로 설치 환경(프로세스 관리자, 인프라 모니터링)의 몫이다.
 * @param pool 메인 DB 풀
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startLogCleanupWatch(pool: Pool): () => Promise<void> {
    let warned = false;
    return startJob(pool, { name: 'log cleanup watch', lock: WATCH_LOCK, intervalMs: WATCH_INTERVAL_MS }, async (ctx) => {
        const { stalled, ageSec } = await checkLogCleanupStall(ctx.conn);
        if (stalled && !warned)
            logger.warn(`log cleanup stalled: last success ${ageSec === null ? 'never' : `${Math.floor(ageSec / 60)} min ago`} — day partitions run out ${AHEAD_DAYS} days after the last success, then rows pile up in p_max`);
        else if (!stalled && warned)
            logger.info('log cleanup recovered');
        warned = stalled;
    });
}
