import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';
import { callSp, LockNotAcquiredError, withLock } from './db.js';
import { formatInstances, listAliveInstances } from './heartbeat.js';
import { logger, shutdownLogger } from './logger.js';

const DATABASE_DIR = join(import.meta.dirname, '..', 'database');
const APP_VERSION = config.appVersion;
const LOCK_NAME = 'podium:migrate';
const LOCK_TIMEOUT_SEC = 10;
const LOCK_WAIT_TIMEOUT_SEC = 2;
const DDL_RETRY_COUNT = 5;
const DDL_RETRY_DELAY_MS = 1000;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_NO_SUCH_TABLE = 1146;

/** 마이그레이션 종류 */
const enum Kind {
    /** 테이블: 한 번만 적용, 적용 후 파일 변경 금지, 파일당 DDL 1개 */
    Versioned = 1,
    /** SP: 체크섬이 바뀌면 다시 적용 (파일 자체가 DROP 후 CREATE). 삭제는 DROP만 남긴 파일로 한다 */
    Repeatable = 2,
}

interface Script {
    name: string;
    kind: Kind;
    statements: string[];
    checksum: string;
}

interface AppliedRow extends RowDataPacket {
    script_name: string;
    kind: Kind;
    checksum: string;
    app_version: string;
}

/**
 * mysql 클라이언트의 DELIMITER 지시어를 해석해 SQL 파일을 구문 단위로 나눈다.
 * mysql2는 DELIMITER를 모르고, SP 본문의 ';'에서 끊으면 안 되기 때문이다.
 * @param sql 파일 내용
 * @returns 실행할 구문 목록
 * @author trisakion
 */
export function splitStatements(sql: string): string[] {
    // ponytail: 줄 끝 구분자만 본다. 문자열·블록 주석 안의 줄 끝 구분자는 구분하지 못한다 — SQL 파일에서 그런 줄을 만들지 않는다.
    const statements: string[] = [];
    let delimiter = ';';
    let buffer: string[] = [];
    for (const line of sql.split('\n')) {
        const directive = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
        if (directive) {
            delimiter = directive[1];
            continue;
        }
        const trimmed = line.trim();
        // 구문 앞의 주석·빈 줄은 버린다 — 파일 헤더가 첫 구문에 붙으면 'SET' 구문 판별이 틀어진다.
        if (buffer.length === 0 && (trimmed === '' || trimmed.startsWith('--')))
            continue;
        buffer.push(line);
        if (!trimmed.startsWith('--') && trimmed.endsWith(delimiter)) {
            const statement = buffer.join('\n').trimEnd().slice(0, -delimiter.length).trim();
            if (statement)
                statements.push(statement);
            buffer = [];
        }
    }
    if (buffer.some((line) => line.trim() !== '' && !line.trim().startsWith('--')))
        throw new Error('구분자로 끝나지 않은 구문이 있습니다.');
    return statements;
}

/**
 * 디렉터리의 .sql 파일을 이름순으로 읽는다.
 * 체크섬은 줄바꿈을 LF로 정규화한 뒤 계산해 OS별 체크아웃 차이로 버전이 달라 보이지 않게 한다.
 * @param dir database/ 하위 디렉터리 이름
 * @param kind 마이그레이션 종류
 * @returns 스크립트 목록
 */
function readScripts(dir: string, kind: Kind): Script[] {
    const fullDir = join(DATABASE_DIR, dir);
    return readdirSync(fullDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => {
            const name = `${dir}/${f}`;
            const sql = readFileSync(join(fullDir, f), 'utf8').replace(/\r\n/g, '\n');
            const statements = splitStatements(sql);
            // DDL은 암묵적으로 커밋되므로 여러 개면 중간 실패 시 일부만 적용된 채 남는다. SET(세션 변수)은 제외하고 센다.
            if (kind === Kind.Versioned && statements.filter((s) => !/^SET\s/i.test(s)).length !== 1)
                throw new Error(`테이블 마이그레이션 파일에는 DDL 구문이 하나만 있어야 합니다: ${name}`);
            return { name, kind, statements, checksum: createHash('sha256').update(sql).digest('hex') };
        });
}

/**
 * 패키지에 포함된 전체 스크립트를 적용 순서대로 읽는다(테이블 → SP).
 * @returns 스크립트 목록
 */
function readAllScripts(): Script[] {
    return [...readScripts('tables', Kind.Versioned), ...readScripts('procedures', Kind.Repeatable)];
}

/**
 * x.y.z 형식 버전을 비교한다.
 * @param a 버전
 * @param b 버전
 * @returns a가 크면 양수, 같으면 0, 작으면 음수
 */
function compareVersion(a: string, b: string): number {
    const parse = (v: string): number[] => {
        if (!/^\d+\.\d+\.\d+$/.test(v))
            throw new Error(`버전 형식은 x.y.z여야 합니다: ${v}`);
        return v.split('.').map(Number);
    };
    const [pa, pb] = [parse(a), parse(b)];
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * 적용 이력을 읽는다.
 * @param conn 커넥션 (풀 또는 락을 잡은 커넥션)
 * @returns 적용 이력. 버전 테이블이 없으면(한 번도 migrate하지 않음) 빈 목록
 */
async function readApplied(conn: Pool | PoolConnection): Promise<AppliedRow[]> {
    try {
        const [rows] = await conn.query<AppliedRow[]>('SELECT script_name, kind, checksum, app_version FROM schema_migration');
        return rows;
    } catch (err) {
        if ((err as { errno?: number }).errno === ER_NO_SUCH_TABLE)
            return [];
        throw err;
    }
}

/**
 * 기동 시 스키마 확인. DB의 적용 이력이 패키지의 스크립트·체크섬과 정확히 같지 않으면 기동을 거부한다.
 * 적용은 하지 않는다 — DB 변경이 있는 배포는 중단 패치(전체 중지 → npm run migrate → 기동)로만 한다.
 * 패키지 버전은 비교하지 않는다 — DB 변경 없는 롤링 배포는 패키지 버전만 바뀌기 때문이다.
 * migrate와 같은 락 안에서 확인하고, 호출 전에 하트비트를 기록해 두어야 한다. 그래야 migrate가 하트비트 검사를
 * 통과한 뒤 기동한 구버전 인스턴스도 락을 기다렸다가 새 스키마로 확인해 거부된다(순서가 바뀌면 이 빈틈이 다시 생긴다).
 * @param pool 커넥션 풀
 * @returns 완료 Promise (불일치 또는 락 획득 실패 시 예외)
 * @author trisakion
 * @modified 2026-10-01 trisakion migrate 락 안에서 확인하도록 변경
 * @modified 2026-10-01 trisakion 락 획득 실패 시 migrate 실행 여부 확인 안내
 * @modified 2026-10-01 trisakion 적용 기록을 SP_GET_SCHEMA_STATE로 조회 (앱 계정은 EXECUTE만)
 */
export async function verifySchema(pool: Pool): Promise<void> {
    const expected = new Map(readAllScripts().map((s) => [s.name, s.checksum]));
    try {
        await withLock(pool, LOCK_NAME, LOCK_TIMEOUT_SEC, async (conn) => {
            // 앱 계정은 EXECUTE만 있어 schema_migration을 직접 읽지 못하므로 SP로 읽는다. SP가 없으면 callSp가 migrate 안내로 던진다.
            const { result, rows } = await callSp(conn, 'SP_GET_SCHEMA_STATE', []);
            if (result !== 0)
                throw new Error(`SP_GET_SCHEMA_STATE RESULT=${result}`);
            const applied = new Map(rows.map((r) => [r.script_name as string, r.checksum as string]));
            const diffs = [
                ...[...expected].filter(([name, sum]) => applied.get(name) !== sum).map(([name]) => `미적용 또는 변경: ${name}`),
                ...[...applied.keys()].filter((name) => !expected.has(name)).map((name) => `패키지에 없음: ${name}`),
            ];
            if (diffs.length)
                throw new Error(`DB 스키마가 앱과 다릅니다. npm run migrate가 필요합니다.\n  ${diffs.join('\n  ')}`);
        });
    } catch (err) {
        if (err instanceof LockNotAcquiredError)
            throw new Error(`스키마 확인용 락(${LOCK_NAME})을 ${LOCK_TIMEOUT_SEC}초 안에 얻지 못했습니다. migrate가 실행 중인지 확인하세요.`, { cause: err });
        throw err;
    }
}

/**
 * 버전 테이블을 만든다. SP가 생기기 전 단계라 러너가 직접 DDL을 실행한다.
 * @param conn 락을 잡은 커넥션
 * @returns 완료 Promise
 */
async function ensureVersionTable(conn: PoolConnection): Promise<void> {
    await conn.query(`
        CREATE TABLE IF NOT EXISTS schema_migration (
            script_name VARCHAR(255)     NOT NULL COMMENT '스크립트 경로 (database/ 기준)',
            kind        TINYINT UNSIGNED NOT NULL COMMENT '종류 (1:버전-테이블, 2:반복-SP)',
            checksum    CHAR(64)         NOT NULL COMMENT '적용한 파일 내용의 SHA-256 (LF 정규화)',
            app_version VARCHAR(32)      NOT NULL COMMENT '적용한 패키지 버전 (package.json version)',
            applied_at  DATETIME(3)      NOT NULL COMMENT '마지막 적용 시각 (UTC)',
            PRIMARY KEY (script_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='마이그레이션 적용 이력 (러너 전용, 스크립트 경로 자연키)'`);
}

/**
 * 구문을 실행하되 MDL 대기 타임아웃(1205)이면 재시도한다.
 * 세션 lock_wait_timeout을 짧게 잡아, DDL이 MDL을 오래 기다리며 뒤의 쿼리를 막는 시간을 제한한다(01_DESIGN 11.1).
 * @param conn 락을 잡은 커넥션
 * @param statement 실행할 구문
 * @returns 완료 Promise
 */
async function execWithRetry(conn: PoolConnection, statement: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await conn.query(statement);
            return;
        } catch (err) {
            if ((err as { errno?: number }).errno !== ER_LOCK_WAIT_TIMEOUT || attempt >= DDL_RETRY_COUNT)
                throw err;
            logger.warn(`lock wait timeout, retry ${attempt}/${DDL_RETRY_COUNT - 1}`);
            await sleep(DDL_RETRY_DELAY_MS);
        }
    }
}

/**
 * 살아 있는 인스턴스가 있으면 거부한다 — 중지하지 않은 채 migrate하는 것을 막는다.
 * @param conn 락을 잡은 커넥션
 * @returns 완료 Promise (살아 있는 인스턴스가 있으면 예외)
 */
async function assertNoAliveInstance(conn: PoolConnection): Promise<void> {
    const rows = await listAliveInstances(conn);
    if (rows.length)
        throw new Error(`실행 중인 인스턴스가 있어 migrate를 거부합니다. 모두 중지한 뒤 다시 실행하세요.\n${formatInstances(rows)}`);
}

/**
 * 대기 중인 마이그레이션을 적용한다. `npm run migrate`에서만 호출한다.
 * 동시 실행은 GET_LOCK으로 막고, 모든 구문을 락을 잡은 전용 커넥션에서 실행한다.
 * @param pool 커넥션 풀
 * @returns 적용한 스크립트 이름 목록
 * @author trisakion
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
    const scripts = readAllScripts();
    return withLock(pool, LOCK_NAME, LOCK_TIMEOUT_SEC, async (conn) => {
        await assertNoAliveInstance(conn);
        await conn.query('SET SESSION lock_wait_timeout = ?', [LOCK_WAIT_TIMEOUT_SEC]);
        try {
            await ensureVersionTable(conn);
            const rows = await readApplied(conn);

            // 낮은 버전 패키지로 실행하면 SP를 구버전 본문으로 되돌리게 되므로 거부한다.
            const newer = rows.find((r) => compareVersion(r.app_version, APP_VERSION) > 0);
            if (newer)
                throw new Error(`DB에 더 높은 버전(${newer.app_version})이 적용되어 있습니다. 현재 패키지: ${APP_VERSION}`);
            const known = new Set(scripts.map((s) => s.name));
            const unknown = rows.find((r) => r.kind === Kind.Versioned && !known.has(r.script_name));
            if (unknown)
                throw new Error(`패키지에 없는 테이블 마이그레이션이 DB에 적용되어 있습니다: ${unknown.script_name}`);

            const applied = new Map(rows.map((r) => [r.script_name, r.checksum]));
            const done: string[] = [];
            for (const script of scripts) {
                const prev = applied.get(script.name);
                if (prev === script.checksum)
                    continue;
                // 적용된 테이블 마이그레이션을 고치면 설치본마다 스키마가 갈라지므로 새 버전 파일로만 변경한다.
                if (prev !== undefined && script.kind === Kind.Versioned)
                    throw new Error(`이미 적용된 마이그레이션이 변경되었습니다: ${script.name}`);
                for (const statement of script.statements)
                    await execWithRetry(conn, statement);
                await conn.query(
                    `INSERT INTO schema_migration (script_name, kind, checksum, app_version, applied_at) VALUES (?, ?, ?, ?, NOW(3)) AS n
                     ON DUPLICATE KEY UPDATE checksum = n.checksum, app_version = n.app_version, applied_at = n.applied_at`,
                    [script.name, script.kind, script.checksum, APP_VERSION],
                );
                logger.info(`migration applied: ${script.name}`);
                done.push(script.name);
            }
            return done;
        } finally {
            // 전용 커넥션은 풀로 돌아가므로 세션 설정을 원래대로 돌려 놓는다.
            await conn.query('SET SESSION lock_wait_timeout = DEFAULT');
        }
    });
}

// `npm run migrate`: 마이그레이션을 적용하고 종료한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { createPool } = await import('./db.js');
    const pool = createPool('MIGRATE');
    try {
        const done = await runMigrations(pool);
        logger.info(done.length ? `migrations done: ${done.length} applied (app ${APP_VERSION})` : 'no pending migrations');
    } catch (err) {
        logger.error('migration failed', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
        await shutdownLogger();
    }
}
