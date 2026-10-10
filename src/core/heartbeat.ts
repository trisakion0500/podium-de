import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ProcessType } from './codes.js';
import { config } from './config.js';
import { callSp } from './db.js';
import { logger } from './logger.js';

const INTERVAL_MS = 10_000;

/** migrate가 "살아 있음"으로 보는 하트비트 유효 시간(초). 주기의 3배 — 한두 번 누락은 살아 있는 것으로 본다 */
export const HEARTBEAT_ALIVE_SEC = 30;

const ER_NO_SUCH_TABLE = 1146;

/**
 * 살아 있는 인스턴스 (instance_heartbeat 행)
 * @author trisakion
 */
export interface AliveInstance extends RowDataPacket {
    instance_id: string;
    process_type: number;
    app_version: string;
    last_seen_at: Date;
}

/**
 * 최근 HEARTBEAT_ALIVE_SEC초 안에 하트비트를 남긴 인스턴스를 조회한다. 비교 기준은 DB 시각(UTC_TIMESTAMP — 세션 time_zone과 무관, D-66)이다.
 * migrate·upgrade가 테이블·SP 생성 전에도 써야 하므로 SP가 아니라 직접 조회하고, 테이블이 없으면(첫 설치) 빈 목록을 돌려준다.
 * @param db 풀 또는 커넥션
 * @returns 살아 있는 인스턴스 목록
 * @author trisakion
 * @modified 2026-10-10 trisakion NOW(3) → UTC_TIMESTAMP(3)
 */
export async function listAliveInstances(db: Pool | PoolConnection): Promise<AliveInstance[]> {
    try {
        const [rows] = await db.query<AliveInstance[]>(
            `SELECT instance_id, process_type, app_version, last_seen_at FROM instance_heartbeat
             WHERE last_seen_at >= UTC_TIMESTAMP(3) - INTERVAL ? SECOND ORDER BY process_type, instance_id`,
            [HEARTBEAT_ALIVE_SEC],
        );
        return rows;
    } catch (err) {
        if ((err as { errno?: number }).errno === ER_NO_SUCH_TABLE)
            return [];
        throw err;
    }
}

/**
 * 인스턴스 목록을 출력용 문자열로 만든다.
 * @param rows 인스턴스 목록
 * @returns 한 줄에 하나씩, 들여쓴 문자열
 * @author trisakion
 */
export function formatInstances(rows: AliveInstance[]): string {
    const typeName = (t: number): string => Object.entries(ProcessType).find(([, v]) => v === t)?.[0] ?? String(t);
    return rows.map((r) => `  ${typeName(r.process_type)} ${r.instance_id} (v${r.app_version}, last seen ${r.last_seen_at.toISOString()})`).join('\n');
}

/**
 * 하트비트를 시작한다. 첫 기록이 실패하면 예외를 던져 기동을 막는다 — 하트비트 없이 뜬 인스턴스는
 * migrate의 실행 중 인스턴스 검사에 보이지 않아, 중지 없이 migrate가 실행될 수 있기 때문이다.
 * last_seen_at은 SP가 DB 시각으로 기록한다 — 호스트 간 시계 차이와 무관하게 migrate가 같은 시계로 비교한다.
 * instance_id는 기동마다 새 UUID다. 비정상 종료로 남은 행은 SP가 기록할 때 함께 지운다(1시간 경과분).
 * @param pool 커넥션 풀
 * @param processType 프로세스 유형
 * @returns 정지 함수. 진행 중 기록을 기다린 뒤 자기 행을 삭제한다
 * @author trisakion
 * @modified 2026-10-01 trisakion instance_id를 호스트:PID에서 기동마다 생성하는 UUID로 변경
 */
export async function startHeartbeat(pool: Pool, processType: number): Promise<() => Promise<void>> {
    const instanceId = randomUUID();
    const beat = async (): Promise<void> => {
        const { result } = await callSp(pool, 'SP_UPSERT_INSTANCE_HEARTBEAT', [instanceId, processType, config.appVersion]);
        if (result !== 0)
            throw new Error(`SP_UPSERT_INSTANCE_HEARTBEAT RESULT=${result}`);
    };
    await beat();
    let inFlight: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
        inFlight = beat().catch((err) => logger.error('heartbeat failed', err));
    }, INTERVAL_MS);
    // migrate 거부 목록에는 UUID만 나오므로, 어느 프로세스인지 로그에서 찾을 수 있게 호스트·PID를 함께 남긴다.
    logger.info(`heartbeat started: ${instanceId} (host ${hostname()}, pid ${process.pid})`);

    return async () => {
        clearInterval(timer);
        // 진행 중 기록이 삭제 뒤에 끝나면 행이 되살아나 유효 시간 동안 migrate를 막으므로 먼저 기다린다.
        await inFlight;
        try {
            await callSp(pool, 'SP_DELETE_INSTANCE_HEARTBEAT', [instanceId]);
        } catch (err) {
            // 삭제에 실패해도 종료는 계속한다. 남은 행은 유효 시간이 지나면 migrate 검사에서 제외된다.
            logger.error('heartbeat delete failed', err);
        }
    };
}
