import type { Pool } from 'mysql2/promise';
import { createPool } from './db.js';
import { startHeartbeat } from './heartbeat.js';
import { logger, shutdownLogger } from './logger.js';
import { verifySchema } from './migrate.js';

/**
 * API·워커 공통 기동 절차: 하트비트 시작 → 스키마 확인(migrate 락 안) → 종료 시그널 등록.
 * 하트비트를 먼저 기록해야 migrate와의 사이에 빈틈이 없다(migrate.verifySchema 참고).
 * 스키마가 패키지와 다르거나 하트비트를 기록하지 못하면 하트비트 행을 지우고 기동하지 않는다.
 * 종료 순서는 처리 중단(beforeClose) → 하트비트 삭제 → DB 풀 → 로거 — 처리가 멈춘 뒤에 하트비트를
 * 지워야 migrate가 아직 일하는 인스턴스를 놓치지 않고, 풀은 마지막에 닫아야 정지 중인 작업이 실패하지 않는다.
 * @param name 로그용 프로세스 이름
 * @param processType 하트비트 프로세스 유형 (codes.ProcessType)
 * @returns 커넥션 풀과 종료 훅 등록 함수. 등록 함수는 같은 종료 절차를 직접 부르는 함수를 돌려준다(listen 실패 등 기동 후반 실패용)
 * @author trisakion
 * @modified 2026-10-01 trisakion 하트비트 기록 후 migrate 락 안에서 스키마 확인, 실패 시 하트비트 삭제
 * @modified 2026-10-06 trisakion 종료 훅 등록 시 종료 함수 반환
 */
export async function bootstrap(name: string, processType: number): Promise<{ pool: Pool; onShutdown: (beforeClose: () => Promise<void>) => (reason: string) => Promise<void> }> {
    const pool = createPool('APP');
    let stopHeartbeat: (() => Promise<void>) | undefined;
    try {
        stopHeartbeat = await startHeartbeat(pool, processType);
        await verifySchema(pool);
    } catch (err) {
        logger.error(`${name} startup failed`, err);
        await stopHeartbeat?.();
        await pool.end();
        await shutdownLogger();
        process.exit(1);
    }

    const onShutdown = (beforeClose: () => Promise<void>): ((reason: string) => Promise<void>) => {
        const shutdown = async (reason: string): Promise<void> => {
            logger.info(`${name} shutting down (${reason})`);
            await beforeClose();
            await stopHeartbeat();
            await pool.end();
            await shutdownLogger();
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return shutdown;
    };
    return { pool, onShutdown };
}
