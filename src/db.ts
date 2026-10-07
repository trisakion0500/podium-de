import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ApiResult } from './codes.js';
import { config, dbCredential, type DbAccount, type DbTarget } from './config.js';
import { BusinessException } from './errors.js';
import { logger } from './logger.js';

const ER_SP_DOES_NOT_EXIST = 1305;

/**
 * MySQL 커넥션 풀을 만든다.
 * 모든 커넥션의 세션 time_zone을 '+00:00'으로 고정한다 — SP의 NOW(3)가 achieved_at과
 * 시즌 시각 검사의 기준이므로 서버 기본값에 의존하지 않는다(01_DESIGN 4.1).
 * @param account 접속 계정. API·워커는 APP, migrate·upgrade는 MIGRATE
 * @param target 대상 DB. 로그 DB는 메인과 다른 풀로 둔다 — 로그 기록이 메인 커넥션을 차지하거나 메인 트랜잭션에 묶이지 않게 한다(개발 컨벤션 7장)
 * @returns 커넥션 풀
 * @author trisakion
 * @modified 2026-10-01 trisakion 접속 계정 인자 추가
 * @modified 2026-10-02 trisakion 대상 DB 인자 추가 (D-48)
 */
export function createPool(account: DbAccount, target: DbTarget = 'MAIN'): Pool {
    const db = target === 'MAIN' ? config.db : config.logDb;
    const pool = mysql.createPool({
        host: db.host,
        port: db.port,
        ...dbCredential(account, target),
        database: db.database,
        connectionLimit: db.poolSize,
        charset: 'UTF8MB4_0900_AI_CI',
        timezone: 'Z',
        // score_max는 2^53 이하(01_DESIGN 2.4)라 number로 정확히 표현된다. 그 이상만 문자열로 받는다.
        supportBigNumbers: true,
    });
    // 'connection' 이벤트는 새 커넥션의 첫 쿼리보다 먼저 큐에 들어가므로 이후 모든 쿼리에 적용된다.
    // 이벤트 인자는 실제로 콜백형 커넥션이라 타입이 맞는 내부 풀(pool.pool)에 건다.
    pool.pool.on('connection', (conn) => {
        conn.query("SET time_zone = '+00:00'", (err: Error | null) => {
            if (err)
                conn.destroy();
        });
    });
    return pool;
}

/**
 * SP 호출 결과. 개발 컨벤션 4.4 — 첫 결과셋은 RESULT 단일 행, 성공 시 두 번째 결과셋이 데이터.
 * @author trisakion
 */
export interface SpResult {
    /** RESULT 코드 (0: 성공) */
    result: number;
    /** 두 번째 결과셋 (실패 또는 데이터 없는 SP는 빈 배열) */
    rows: RowDataPacket[];
}

/**
 * SP를 호출한다. 값은 항상 파라미터 바인딩으로 전달한다(개발 컨벤션 14.2).
 * RESULT=50001(SP 내부 시스템 오류)은 값으로 돌려주지 않고 여기서 예외로 던진다 — 호출부가
 * 비즈니스 코드만 분기하면 되도록 한 곳에서 처리한다(개발 컨벤션 9).
 * @param db 풀 또는 전용 커넥션
 * @param name SP 이름 (SP_ 접두 대문자만 허용 — 식별자는 바인딩이 안 되므로 형식으로 제한)
 * @param params IN 파라미터
 * SP가 없으면(미적용 DB) migrate 안내로 바꿔 던진다 — 기동 시 처음 부르는 SP에서 원인이 바로 보이게 한다.
 * @returns RESULT 코드와 데이터 행
 * @author trisakion
 * @modified 2026-10-01 trisakion SP 없음(1305)을 migrate 안내 오류로 변환
 * @modified 2026-10-06 trisakion RESULT=50001을 BusinessException(DATABASE_ERROR)으로 던짐
 * @modified 2026-10-07 trisakion 데이터 결과셋 자리에 온 50001(RESULT 0 이후 SELECT 실패)도 DB 오류로 던짐
 */
export async function callSp(db: Pool | PoolConnection, name: string, params: unknown[]): Promise<SpResult> {
    if (!/^SP_[A-Z0-9_]+$/.test(name))
        throw new Error(`잘못된 SP 이름: ${name}`);
    const placeholders = params.map(() => '?').join(', ');
    let sets: RowDataPacket[][];
    try {
        [sets] = await db.query<RowDataPacket[][]>(`CALL ${name}(${placeholders})`, params);
    } catch (err) {
        if ((err as { errno?: number }).errno === ER_SP_DOES_NOT_EXIST)
            throw new Error(`${name}이(가) DB에 없습니다. npm run migrate가 필요합니다.`, { cause: err });
        throw err;
    }
    const head = sets[0]?.[0];
    if (!head || typeof head.RESULT !== 'number')
        throw new Error(`${name}: RESULT 결과셋이 없습니다.`);
    const rows = Array.isArray(sets[1]) ? sets[1] : [];
    // RESULT 0을 보낸 뒤 데이터 SELECT가 실패하면 핸들러의 50001이 두 번째 결과셋으로 온다. 데이터 결과셋에는
    // RESULT 컬럼이 없으므로(개발 컨벤션 4.4) 이것도 DB 오류로 본다 — 오류 행을 데이터로 돌려주면 조용히 틀린다.
    const failed = head.RESULT === ApiResult.DATABASE_ERROR ? head : rows[0]?.RESULT === ApiResult.DATABASE_ERROR ? rows[0] : undefined;
    if (failed)
        throw new BusinessException(ApiResult.DATABASE_ERROR, `${name}: DB 오류 ${failed.ERROR_NO} (${failed.SQL_STATE}) ${failed.ERROR_MESSAGE}`, {
            sqlState: failed.SQL_STATE,
            errorNo: failed.ERROR_NO,
        });
    return { result: head.RESULT, rows };
}

/**
 * 다른 세션이 락을 보유하고 있어 얻지 못했을 때 던진다. 배치는 이 예외로 "이번 차례 건너뜀"을 구분한다.
 * @author trisakion
 */
export class LockNotAcquiredError extends Error {
    /**
     * @param lockName 락 이름
     */
    constructor(readonly lockName: string) {
        super(`락(${lockName})을 얻지 못했습니다. 다른 프로세스가 보유 중입니다.`);
    }
}

/**
 * 이름 있는 락(GET_LOCK)을 잡고 작업을 실행한다. 락 획득 → 작업 → RELEASE_LOCK → 커넥션 반납을 보장한다.
 * GET_LOCK은 커넥션 세션에 묶이므로 풀에서 전용 커넥션을 받아 작업이 끝날 때까지 반납하지 않는다.
 * SP가 아니라 GET_LOCK을 직접 호출한다 — 러너가 SP 생성 전에도 써야 하기 때문이다.
 * @param pool 커넥션 풀
 * @param lockName 락 이름
 * @param timeoutSec 획득 대기 시간 (0: 즉시 포기)
 * @param work 락을 보유한 동안 실행할 작업. 전용 커넥션을 받는다
 * @returns 작업 결과
 * @author trisakion
 */
export async function withLock<T>(pool: Pool, lockName: string, timeoutSec: number, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await pool.getConnection();
    let healthy = true;
    try {
        const [[row]] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeoutSec]);
        if (row.acquired !== 1)
            throw new LockNotAcquiredError(lockName);
        try {
            return await work(conn);
        } finally {
            try {
                await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
            } catch (err) {
                // 해제 여부를 알 수 없는 커넥션을 풀에 돌려주면, 같은 커넥션에서 GET_LOCK이 재진입으로 성공해
                // 상호 배제가 깨진다. 세션을 끊어 서버가 락을 확실히 풀게 한다.
                healthy = false;
                logger.error(`RELEASE_LOCK(${lockName}) failed, destroying connection`, err);
            }
        }
    } finally {
        if (healthy)
            conn.release();
        else
            conn.destroy();
    }
}

/**
 * 이 커넥션이 락을 아직 보유하고 있는지 확인한다. 장시간 작업이 청크 사이에 호출한다.
 * 커넥션이 끊겼다 재연결되었거나 KILL 등으로 세션이 바뀌면 락을 잃은 상태이므로 작업을 중단시킨다.
 * @param conn withLock이 넘겨준 전용 커넥션
 * @param lockName 락 이름
 * @returns 완료 Promise (보유하지 않으면 예외)
 * @author trisakion
 */
export async function assertLockHeld(conn: PoolConnection, lockName: string): Promise<void> {
    const [[row]] = await conn.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [lockName]);
    if (row.held !== 1)
        throw new Error(`락(${lockName})을 보유하고 있지 않습니다. 작업을 중단합니다.`);
}
