import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { ApiResult, SpResult } from './codes.js';
import { callSp } from './db.js';
import { BusinessException } from './errors.js';
import { logger } from './logger.js';

/** 활성 키 목록 재조회 주기 (01_DESIGN 10.1) */
const REFRESH_INTERVAL_MS = 30_000;

/** 재조회가 이 횟수만큼 연속 실패하면 error로 알린다 — 폐기한 키가 계속 통과하는 상태이기 때문이다 */
const REFRESH_ALERT_AFTER = 3;

/**
 * 메모리에 둔 활성 키 하나
 * @author trisakion
 */
interface ActiveCredential {
    /** api_credential_id. 로그에는 키 대신 이 값을 남긴다 */
    id: number;
    /** 권한 비트 (codes.ApiScope) */
    scopes: number;
}

/** 키 해시(hex) → 활성 키. 재조회 때 통째로 바꿔 끼운다 */
let credentials = new Map<string, ActiveCredential>();

/**
 * API 키의 SHA-256 해시. 발급 CLI(저장)와 인증(비교)이 같은 함수를 써야 한다.
 * 키가 32바이트 난수라 느린 해시가 필요 없다 (D-54).
 * @param key 키 원문 (base64url 43자)
 * @returns 32바이트 해시
 * @author trisakion
 */
export function hashApiKey(key: string): Buffer {
    return createHash('sha256').update(key).digest();
}

/**
 * 활성 키 목록을 DB에서 읽어 메모리 목록을 바꾼다.
 * @param pool 메인 DB 풀
 * @returns 읽은 키 수
 */
async function load(pool: Pool): Promise<number> {
    const { result, rows } = await callSp(pool, 'SP_LIST_API_CREDENTIAL', [0]);
    if (result !== SpResult.OK)
        throw new Error(`SP_LIST_API_CREDENTIAL result ${result}`);
    credentials = new Map(rows.map((r) => [(r.key_hash as Buffer).toString('hex'), { id: r.api_credential_id as number, scopes: r.scopes as number }]));
    return credentials.size;
}

/**
 * 활성 키 목록을 읽고 30초마다 다시 읽는다 (01_DESIGN 10.1).
 * 기동 시 읽기 실패는 예외로 던진다 — 키 없이 뜨면 모든 요청이 401이라 뜨지 않는 편이 낫다.
 * 재조회 실패는 기존 목록을 유지하고 경고한다. 연속 실패는 폐기가 반영되지 않는 상태라 error로 올린다.
 * @param pool 메인 DB 풀
 * @param intervalMs 재조회 주기 (테스트용, 기본 30초)
 * @returns 재조회 정지 함수. 정상 종료 때 DB 풀보다 먼저 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export async function startCredentialRefresh(pool: Pool, intervalMs = REFRESH_INTERVAL_MS): Promise<() => void> {
    const count = await load(pool);
    logger.info(`api credentials loaded: ${count}`);
    if (count === 0)
        logger.warn('no active api credential — all requests will be rejected (npm run credential -- create)');

    let failures = 0;
    const timer = setInterval(async () => {
        try {
            await load(pool);
            if (failures >= REFRESH_ALERT_AFTER)
                logger.info(`api credential refresh recovered after ${failures} failures`);
            failures = 0;
        } catch (err) {
            failures++;
            if (failures >= REFRESH_ALERT_AFTER)
                logger.error(`api credential refresh failed ${failures} times in a row — revocations are not applied, keeping ${credentials.size} keys`, err);
            else
                logger.warn(`api credential refresh failed, keeping ${credentials.size} keys`, err);
        }
    }, intervalMs);
    return () => clearInterval(timer);
}

/**
 * 라우트의 onRequest 훅으로 붙이는 인증 가드. x-api-key 헤더의 해시로 메모리 목록을 찾고 권한 비트를 확인한다.
 * onRequest(바디 파싱 전)에 둬서 인증되지 않은 요청은 바디를 읽지 않고, 요청 형식 오류(2001)보다 인증 오류가 먼저 나간다.
 * 원문이 아니라 해시로 찾으므로, 조회 시간 차이로 키를 한 글자씩 맞혀 가는 타이밍 공격이 성립하지 않는다.
 * @param scope 필요한 권한 비트 (codes.ApiScope)
 * @returns onRequest 훅. 통과하면 req.credentialId를 채운다(응답 로그용)
 * @author trisakion
 */
export function requireScope(scope: number): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
    return async (req) => {
        const key = req.headers['x-api-key'];
        const credential = typeof key === 'string' ? credentials.get(hashApiKey(key).toString('hex')) : undefined;
        if (!credential)
            throw new BusinessException(ApiResult.UNAUTHORIZED);
        req.credentialId = credential.id;
        if ((credential.scopes & scope) === 0)
            throw new BusinessException(ApiResult.FORBIDDEN);
    };
}
