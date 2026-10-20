import type { Pool, PoolConnection } from 'mysql2/promise';
import { PartitionTarget, SpResult } from '../core/codes.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob } from './loop.js';
import type { StallTarget } from './stall.js';

/** 백업 분리 잡 락. 워커 여러 대 중 한 곳에서만 돈다 */
const ARCHIVE_LOCK = 'podium:archive';

/** 주기. 분리는 서두를 일이 아니고, DDL이 MDL을 못 잡으면(1205) 다음 주기에 다시 한다 (01_DESIGN 11.1) */
const INTERVAL_MS = 3_600_000;

/** 오래된 백업 경고에 이름을 몇 개까지 찍을지 */
const EXPIRED_SHOWN = 5;

/**
 * 정체 감시 대상 (stall.ts). 분리가 멈추면 SETTLED 시즌 파티션이 운영 테이블에 남아 테이블당 상한(8192)에 다가간다
 * @author trisakion
 */
export const ARCHIVE_STALL: StallTarget = {
    job: 'archive',
    name: 'archive',
    impact: 'SETTLED season partitions stay in ranking_entry/ranking_submit_key (limit 8192 per table)',
};

/**
 * 보관 기간이 지난 백업 테이블 하나 (SP_LIST_BACKUP_EXPIRED)
 * @author trisakion
 */
export interface ExpiredBackup {
    tableName: string;
    rankingCode: string;
    /** 시즌 종료 시각 (UTC) */
    endAt: Date;
}

/**
 * 백업 분리 한 번의 결과
 * @author trisakion
 */
export interface ArchiveResult {
    /** 백업 테이블로 옮긴 파티션 수 (entry, submit_key 각각 센다) */
    exchanged: number;
    /** 지운 빈 파티션 수 */
    dropped: number;
    /** entry 분리를 다음 시즌 SETTLED까지 기다리는 시즌 수 (1004, D-52) */
    waiting: number;
    /** 보관 기간이 지난 백업 테이블 (오래된 것부터) */
    expired: ExpiredBackup[];
}

/**
 * SETTLED 시즌의 파티션을 백업 테이블로 분리하고 빈 파티션을 지운다 (01_DESIGN 8.2). 보관 기간이 지난 백업 테이블도 함께 찾는다(8.3).
 * submit_key는 자기 시즌 SETTLED면 바로, entry는 다음 시즌도 SETTLED여야 분리한다 — 조건 판단은 SP가 하고 1004면 다음 주기를 기다린다.
 * 관리 SP는 상태를 관측해 다음 단계만 하므로 중간에 끊겨도 다음 주기가 이어서 한다.
 * @param conn 락을 쥔 메인 DB 커넥션
 * @param checkpoint 시즌 사이마다 부른다. 락을 잃었거나 종료 중이면 예외로 멈춘다
 * @returns 분리 결과
 * @author trisakion
 */
export async function runArchive(conn: PoolConnection | Pool, checkpoint: () => Promise<void> = async () => {}): Promise<ArchiveResult> {
    const out: ArchiveResult = { exchanged: 0, dropped: 0, waiting: 0, expired: [] };
    const targets = await callSp(conn, 'SP_LIST_ARCHIVE_TARGET', []);
    if (targets.result !== SpResult.OK)
        throw new Error(`SP_LIST_ARCHIVE_TARGET result ${targets.result}`);
    for (const { ranking_id: rankingId, season_no: seasonNo } of targets.rows) {
        // submit_key 먼저: 조건이 더 이르게 풀린다. entry가 기다려도 submit_key는 이번에 빠진다
        for (const target of [PartitionTarget.SUBMIT_KEY, PartitionTarget.ENTRY]) {
            await checkpoint();
            const ex = await callSp(conn, 'SP_PARTITION_EXCHANGE', [target, rankingId, seasonNo]);
            if (ex.result === SpResult.NEXT_SEASON_NOT_SETTLED) {
                out.waiting++;
                continue;
            }
            if (ex.result !== SpResult.OK)
                throw new Error(`SP_PARTITION_EXCHANGE result ${ex.result} target=${target} ranking=${rankingId} season=${seasonNo}`);
            out.exchanged += ex.rows[0].exchanged;
            const dr = await callSp(conn, 'SP_PARTITION_DROP', [target, rankingId, seasonNo]);
            if (dr.result !== SpResult.OK)
                throw new Error(`SP_PARTITION_DROP result ${dr.result} target=${target} ranking=${rankingId} season=${seasonNo}`);
            out.dropped += dr.rows[0].dropped;
        }
    }
    const expired = await callSp(conn, 'SP_LIST_BACKUP_EXPIRED', []);
    if (expired.result !== SpResult.OK)
        throw new Error(`SP_LIST_BACKUP_EXPIRED result ${expired.result}`);
    out.expired = expired.rows.map((r) => ({ tableName: r.table_name, rankingCode: r.ranking_code, endAt: r.end_at }));
    return out;
}

/**
 * 오래된 백업 경고 문구. 운영자가 어떤 랭킹·시즌인지 바로 알도록 코드와 종료일을 붙인다
 * @param list 보관 기간이 지난 백업 (오래된 것부터)
 * @returns 경고 문구
 * @author trisakion
 */
export function expiredMessage(list: ExpiredBackup[]): string {
    const shown = list.slice(0, EXPIRED_SHOWN).map((b) => `${b.tableName} (${b.rankingCode}, ended ${b.endAt.toISOString().slice(0, 10)})`);
    const more = list.length > EXPIRED_SHOWN ? `, … ${list.length - EXPIRED_SHOWN} more` : '';
    return `season backups past history_retention: ${list.length} tables — dump and drop them: ${shown.join(', ')}${more}`;
}

/**
 * 백업 분리 잡을 시작한다 (01_DESIGN 8.2, 8.3, 11.1). 성공하면 job_state('archive')의 last_run_at을 남겨 정체 감시가 볼 수 있게 한다.
 * 보관 기간이 지난 백업은 지우지 않고 경고만 한다 — 생기면 한 번, 모두 정리되면 한 번 (주기마다 반복하지 않는다).
 * @param pool 메인 DB 풀
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startArchive(pool: Pool): () => Promise<void> {
    let warned = false;
    const stop = startJob(pool, { name: 'archive', lock: ARCHIVE_LOCK, intervalMs: INTERVAL_MS }, async (ctx) => {
        const r = await runArchive(ctx.conn, ctx.checkpoint);
        if (r.exchanged > 0 || r.dropped > 0)
            logger.info(`season partitions archived exchanged=${r.exchanged} dropped=${r.dropped} waiting=${r.waiting}`);
        if (r.expired.length > 0 && !warned)
            logger.warn(expiredMessage(r.expired));
        else if (r.expired.length === 0 && warned)
            logger.info('season backups past history_retention: none left');
        warned = r.expired.length > 0;
        const { result } = await callSp(ctx.conn, 'SP_UPSERT_JOB_STATE', ['archive', 0, 0, null]);
        if (result !== SpResult.OK)
            throw new Error(`SP_UPSERT_JOB_STATE result ${result}`);
    });
    logger.info('archive started');
    return stop;
}
