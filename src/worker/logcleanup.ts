import type { Pool } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob } from './loop.js';
import type { StallTarget } from './stall.js';

/** 로그 정리 잡 락 (메인 DB). 워커 여러 대 중 한 곳에서만 돈다 */
const LOG_CLEANUP_LOCK = 'podium:log-cleanup';

/** 주기. 하루 한 번이면 되지만, 실패나 워커 정지 뒤에 하루를 기다리지 않고 따라잡도록 1시간마다 본다. 할 일이 없으면 SP 세 번뿐이다 */
const INTERVAL_MS = 3_600_000;

/** 일 파티션을 오늘부터 며칠 뒤까지 미리 만들지. 잡이 이 기간 안에 다시 돌면 p_max에 행이 쌓이지 않는다 */
const AHEAD_DAYS = 7;

/**
 * 정체 감시 대상 (stall.ts). 마지막 성공 후 AHEAD_DAYS가 지나면 미리 만든 일 파티션이 바닥난다
 * @author trisakion
 */
export const LOG_CLEANUP_STALL: StallTarget = {
    job: 'log_cleanup',
    name: 'log cleanup',
    impact: `day partitions run out ${AHEAD_DAYS} days after the last success, then rows pile up in p_max`,
};

/**
 * 로그 정리 한 번의 결과
 * @author trisakion
 */
export interface LogCleanupResult {
    added: number;
    /** 월 테이블로 옮긴 일 파티션 수 */
    archived: number;
    /** 보관 기간이 지나 지운 월 테이블 수 */
    droppedMonths: number;
    /** 재구성 전 p_max에 행이 있었는지 — 그날 파티션을 제때 만들지 못한 것이다 (01_DESIGN 11.4) */
    pmaxHadRows: boolean;
}

/**
 * 결과 수가 0이 될 때까지 관리 SP를 다시 부른다. 관리 SP는 호출당 처리 수에 상한이 있다 — 오래 멈췄다 재개한 경우다.
 * @param logPool 로그 DB 풀
 * @param sp SP 이름
 * @param arg SP 인자
 * @param field 처리 수 컬럼
 * @param checkpoint 처리가 있었던 호출 뒤마다 부른다
 * @returns 처리 수 합계
 */
async function drain(logPool: Pool, sp: string, arg: number, field: string, checkpoint: () => Promise<void>): Promise<number> {
    let total = 0;
    for (;;) {
        const { result, rows } = await callSp(logPool, sp, [arg]);
        if (result !== SpResult.OK)
            throw new Error(`${sp} result ${result}`);
        if (rows[0][field] === 0)
            return total;
        total += rows[0][field];
        await checkpoint();
    }
}

/**
 * 로그 DB 제출 이력의 일 파티션을 정리한다 (01_DESIGN 4.5): 오늘 + AHEAD_DAYS까지 만들고, 보관 기간이 지난 것을 월 테이블로 옮기고,
 * 보관 개월 수가 지난 월 테이블을 지운다.
 * 날짜는 SP가 DB 시각으로 계산한다. created_at이 로그 DB 시각이라 호스트 시계와 무관하게 같은 기준이 된다.
 * @param logPool 로그 DB 풀
 * @param retentionDays 보관 일수 (LOG_RETENTION_DAYS)
 * @param archiveMonths 월 테이블 보관 개월 수 (LOG_ARCHIVE_MONTHS)
 * @param checkpoint SP 호출 사이마다 부른다. 락을 잃었거나 종료 중이면 예외로 멈춘다
 * @returns 만든·옮긴 파티션 수, 지운 월 테이블 수, p_max 행 여부
 * @author trisakion
 * @modified 2026-10-20 trisakion 보관 기간이 지난 일 파티션을 지우지 않고 월 테이블로 옮김, 월 테이블 삭제 추가
 */
export async function cleanupLogPartitions(logPool: Pool, retentionDays: number, archiveMonths: number, checkpoint: () => Promise<void> = async () => {}): Promise<LogCleanupResult> {
    const out: LogCleanupResult = { added: 0, archived: 0, droppedMonths: 0, pmaxHadRows: false };
    for (let first = true; ; first = false) {
        const { result, rows } = await callSp(logPool, 'SP_LOG_PARTITION_ADD', [AHEAD_DAYS]);
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
    out.archived = await drain(logPool, 'SP_LOG_PARTITION_ARCHIVE', retentionDays, 'archived_count', checkpoint);
    out.droppedMonths = await drain(logPool, 'SP_LOG_ARCHIVE_DROP', archiveMonths, 'dropped_count', checkpoint);
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
        const r = await cleanupLogPartitions(logPool, config.logRetentionDays, config.logArchiveMonths, ctx.checkpoint);
        if (r.pmaxHadRows)
            logger.warn('log_ranking_submit p_max had rows — day partitions were not created in time (log cleanup stopped?)');
        if (r.added > 0 || r.archived > 0 || r.droppedMonths > 0)
            logger.info(`log partitions added=${r.added} archived=${r.archived} month tables dropped=${r.droppedMonths}`);
        const { result } = await callSp(ctx.conn, 'SP_UPSERT_JOB_STATE', ['log_cleanup', 0, 0, null]);
        if (result !== SpResult.OK)
            throw new Error(`SP_UPSERT_JOB_STATE result ${result}`);
    });
    logger.info(`log cleanup started (retention ${config.logRetentionDays} days, archive ${config.logArchiveMonths} months)`);
    return stop;
}
