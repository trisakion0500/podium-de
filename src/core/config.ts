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
 * @modified 2026-10-06 trisakion API 수신 주소, 처리 제한 시간, Swagger UI 설정 추가
 * @modified 2026-10-07 trisakion Redis 접속 설정 추가
 * @modified 2026-10-09 trisakion 복구 잡 설정 추가
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
    /**
     * 수신 주소. Fastify 기본값(localhost)은 로드밸런서에서 닿지 않아 '::'(IPv6+IPv4 겸용)을 쓴다.
     * '0.0.0.0'은 Windows에서 같은 포트를 쓰는 다른 프로세스가 있어도 오류 없이 함께 열려 충돌을 숨긴다.
     * IPv6가 꺼진 호스트만 0.0.0.0으로 바꾼다.
     */
    apiHost: process.env.API_HOST || '::',
    /** 요청 처리 제한 시간(ms). 넘으면 TIMEOUT 응답만 보내고 진행 중 작업은 취소하지 않는다 (개발 컨벤션 7.2) */
    apiTimeoutMs: int('API_TIMEOUT_MS', 30000),
    /** 1이면 Swagger UI(/docs)를 연다. 설치본 운영 환경에 API 구조를 기본으로 드러내지 않도록 기본은 끈다 */
    apiDocs: int('API_DOCS', 0) === 1,
    /** Redis 실시간 순위표 (01_DESIGN 5장). 원장은 MySQL이라 Redis 장애는 기동을 막지 않는다 */
    redis: {
        url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        password: process.env.REDIS_PASSWORD || undefined,
        /** 모든 키 앞에 붙는 접두어. 한 Redis를 여러 서비스가 함께 쓸 때 키 충돌을 막는다 (예: ped:) */
        keyPrefix: process.env.REDIS_KEY_PREFIX ?? '',
        /** 명령 하나의 제한 시간(ms). 넘으면 실패로 보고 응답을 진행한다 (D-53) */
        timeoutMs: int('REDIS_TIMEOUT_MS', 500),
    },
    /** 워커 복구 잡 (01_DESIGN 6.2~6.4) */
    recovery: {
        /** 주기(ms). 새 시즌이 열린 뒤 센티넬이 생기기까지, 놓친 반영이 따라잡히기까지의 최대 지연이다 */
        intervalMs: int('RECOVERY_INTERVAL_MS', 5000),
        /** 동기화 시각 안전마진(초). 최대 트랜잭션 시간보다 길어야 커밋이 늦은 행을 놓치지 않는다 */
        marginSec: int('RECOVERY_MARGIN_SEC', 60),
        /** MySQL에서 한 번에 읽는 행 수 (1~10000) */
        chunk: int('RECOVERY_CHUNK', 1000),
    },
    /** npm run upgrade 설정. 명령이 없으면 upgrade가 1단계 전에 중단한다 */
    upgrade: {
        stopCmd: process.env.UPGRADE_STOP_CMD ?? '',
        startCmd: process.env.UPGRADE_START_CMD ?? '',
        expectApi: int('UPGRADE_EXPECT_API', 1),
        expectWorker: int('UPGRADE_EXPECT_WORKER', 1),
        timeoutSec: int('UPGRADE_TIMEOUT_SEC', 120),
    },
    /** 패키지 버전 (package.json version). 마이그레이션 기록과 하트비트에 남긴다 */
    appVersion: JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version as string,
} as const;
