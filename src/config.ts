import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 운영 환경은 프로세스 환경 변수로 주입하므로 .env는 로컬 편의용으로만 읽는다.
if (existsSync('.env'))
    process.loadEnvFile('.env');

/**
 * 필수 환경 변수를 읽는다. 누락 시 기동을 멈춰 잘못된 설정으로 뜨는 것을 막는다.
 * @param name 환경 변수 이름
 * @returns 환경 변수 값
 */
function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '')
        throw new Error(`환경 변수 ${name}이(가) 설정되지 않았습니다.`);
    return value;
}

/**
 * 정수 환경 변수를 읽는다.
 * @param name 환경 변수 이름
 * @param fallback 미설정 시 기본값
 * @returns 정수 값
 */
function int(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value))
        throw new Error(`환경 변수 ${name}은(는) 정수여야 합니다: ${raw}`);
    return value;
}

/**
 * DB 계정 구분. APP: API·워커 (EXECUTE만), MIGRATE: migrate·upgrade (스키마 전체 권한, SP DEFINER)
 * @author trisakion
 */
export type DbAccount = 'APP' | 'MIGRATE';

/**
 * DB 구분. MAIN: 원장 podium_de, LOG: 제출 이력 등 로그 DB (D-48)
 * @author trisakion
 */
export type DbTarget = 'MAIN' | 'LOG';

/**
 * DB 계정 자격 증명을 읽는다. 계정별로 필요할 때만 읽어, API·워커 호스트에 migrate 계정 정보가 없어도 기동되게 한다.
 * 로그 DB는 별도 인스턴스일 수 있으므로 메인 계정을 재사용하지 않고 DB_LOG_* 계정을 따로 읽는다.
 * @param account 계정 구분
 * @param target 대상 DB
 * @returns 사용자와 비밀번호
 * @author trisakion
 * @modified 2026-10-02 trisakion 로그 DB 계정 분리 (DB_LOG_APP_*, DB_LOG_MIGRATE_*)
 */
export function dbCredential(account: DbAccount, target: DbTarget = 'MAIN'): { user: string; password: string } {
    const prefix = target === 'LOG' ? 'DB_LOG_' : 'DB_';
    return { user: required(`${prefix}${account}_USER`), password: process.env[`${prefix}${account}_PASSWORD`] ?? '' };
}

const mainDb = {
    host: required('DB_HOST'),
    port: int('DB_PORT', 3306),
    database: required('DB_NAME'),
    poolSize: int('DB_POOL_SIZE', 10),
};

/**
 * 프로세스 설정. API·워커 엔트리가 공유한다.
 * @author trisakion
 * @modified 2026-10-01 trisakion DB 계정을 APP/MIGRATE로 분리 (dbCredential)
 * @modified 2026-10-02 trisakion 로그 DB 접속 설정 추가 (D-48)
 */
export const config = {
    db: mainDb,
    /**
     * 로그 DB. 접속 정보는 필수다 — 비었을 때 메인 인스턴스로 대체하면 설정 누락이 조용히 장애 격리(D-48)를 무너뜨린다.
     * 누락은 배포 실수라 기동을 막고, 접속 장애는 운영 중 일이라 기동 확인에서 경고만 한다(migrate.verifySchema).
     */
    logDb: {
        host: required('DB_LOG_HOST'),
        port: int('DB_LOG_PORT', 3306),
        database: required('DB_LOG_NAME'),
        poolSize: int('DB_LOG_POOL_SIZE', 5),
    },
    /** 로그 DB 제출 이력 보관 일수 (01_DESIGN 4.5) */
    logRetentionDays: int('LOG_RETENTION_DAYS', 90),
    apiPort: int('API_PORT', 3000),
    /** npm run upgrade 설정. 명령이 없으면 upgrade가 1단계 전에 중단한다 */
    upgrade: {
        stopCmd: process.env.UPGRADE_STOP_CMD ?? '',
        startCmd: process.env.UPGRADE_START_CMD ?? '',
        expectApi: int('UPGRADE_EXPECT_API', 1),
        expectWorker: int('UPGRADE_EXPECT_WORKER', 1),
        timeoutSec: int('UPGRADE_TIMEOUT_SEC', 120),
    },
    /** 패키지 버전 (package.json version). 마이그레이션 기록과 하트비트에 남긴다 */
    appVersion: JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string,
} as const;
