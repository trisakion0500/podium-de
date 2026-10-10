import type { Pool, PoolConnection } from 'mysql2/promise';
import { assertLockHeld, LockNotAcquiredError, withLock } from '../core/db.js';
import { logger } from '../core/logger.js';

/**
 * 정상 종료로 작업을 멈출 때 던진다. 루프는 이 예외를 오류로 남기지 않는다.
 * @author trisakion
 */
export class StoppedError extends Error {}

/**
 * 한 주기의 실행 문맥. 락을 쥔 전용 커넥션으로 모든 SP를 부른다 — 청크마다 락 보유를 확인한다(01_DESIGN 11.3).
 * @author trisakion
 */
export interface JobContext {
    conn: PoolConnection;
    /** 청크 사이마다 부른다. 락을 잃었거나 종료 중이면 예외로 이번 주기를 끝낸다 */
    checkpoint: () => Promise<void>;
}

/**
 * 잡 실행 옵션
 * @author trisakion
 */
export interface JobOptions {
    /** 로그에 쓰는 잡 이름 */
    name: string;
    /** GET_LOCK 이름. 워커 여러 대 중 한 곳에서만 돈다 */
    lock: string;
    /** 주기(ms). 이전 주기가 끝난 뒤부터 잰다 */
    intervalMs: number;
    /** false면 이번 주기를 건너뛴다 (예: Redis 끊김) */
    ready?: () => boolean;
}

/**
 * 워커 잡을 주기로 실행한다. 주기마다 GET_LOCK을 즉시 시도해 한 워커에서만 돌고(개발 컨벤션 5.1), 이전 주기가 끝난 뒤
 * 다음 주기를 예약해 겹치지 않는다. 주기 실패는 로그만 남기고 다음 주기에 다시 한다 — 잡은 상태를 관측해 이어서 진행한다.
 * @param pool 메인 DB 풀
 * @param opts 잡 옵션
 * @param cycle 한 주기 작업
 * @returns 정지 함수. 진행 중인 주기가 checkpoint에서 멈출 때까지 기다린다. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startJob(pool: Pool, opts: JobOptions, cycle: (ctx: JobContext) => Promise<void>): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> = Promise.resolve();

    const tick = async (): Promise<void> => {
        if (opts.ready?.() ?? true) {
            try {
                await withLock(pool, opts.lock, 0, (conn) => cycle({
                    conn,
                    checkpoint: async () => {
                        if (stopped)
                            throw new StoppedError();
                        await assertLockHeld(conn, opts.lock);
                    },
                }));
            } catch (err) {
                if (err instanceof LockNotAcquiredError)
                    logger.debug(`${opts.name} skipped: another worker holds the lock`);
                else if (!(err instanceof StoppedError))
                    logger.error(`${opts.name} cycle failed`, err);
            }
        }
        if (!stopped)
            timer = setTimeout(() => { running = tick(); }, opts.intervalMs);
    };

    running = tick();
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}
