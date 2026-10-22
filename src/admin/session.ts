import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { ApiResult, SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSpRows } from '../core/db.js';
import { BusinessException } from '../core/errors.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** 세션 가드를 통과한 GM (인증 없는 경로·인증 실패는 null). admin.ts가 decorateRequest로 선언한다 */
        admin: AdminIdentity | null;
    }
}

/**
 * 세션으로 확인한 GM. 역할은 세션이 아니라 요청마다 계정 행에서 읽은 값이다 (01_DESIGN 10.4)
 * @author trisakion
 */
export interface AdminIdentity {
    /** admin_session_id (로그아웃용) */
    sessionId: number;
    /** admin_account_id */
    accountId: number;
    /** 로그인 아이디 */
    loginId: string;
    /** 표시 이름 */
    name: string;
    /** 역할 (codes.AdminRole) */
    role: number;
    /** 초기 비밀번호라 먼저 바꿔야 함 */
    mustChangePassword: boolean;
}

/**
 * 세션 쿠키 이름. `__Host-` 접두어가 있으면 브라우저가 Secure 없는 쿠키와 Domain 지정을 거부해,
 * 하위 도메인이나 평문 HTTP에서 쿠키를 덮어쓰는 공격을 막는다.
 * @author trisakion
 */
export const SESSION_COOKIE = '__Host-podium_admin';
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/**
 * 세션 토큰의 SHA-256 해시. DB에는 이 값만 둔다. 토큰이 32바이트 난수라 느린 해시가 필요 없다 (API 키와 같다, D-54).
 * @param token 토큰 원문 (base64url 43자)
 * @returns 32바이트 해시
 * @author trisakion
 */
export function hashToken(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

/**
 * 새 세션 토큰을 만든다.
 * @returns 원문(쿠키용)과 해시(DB용)
 * @author trisakion
 */
export function newSessionToken(): { token: string; hash: Buffer } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
}

/**
 * 세션 쿠키를 응답에 싣는다. 만료(Max-Age)는 두지 않는다 — 실제 만료는 서버가 판단하고, 브라우저를 닫으면 쿠키도 없어진다.
 * @param reply 응답
 * @param token 토큰 원문
 * @author trisakion
 */
export function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.header('set-cookie', `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRS}`);
}

/**
 * 세션 쿠키를 지운다 (로그아웃).
 * @param reply 응답
 * @author trisakion
 */
export function clearSessionCookie(reply: FastifyReply): void {
    reply.header('set-cookie', `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`);
}

/**
 * Cookie 헤더에서 세션 토큰을 꺼낸다. 쿠키 하나만 읽으면 되어 파서 의존성을 두지 않는다.
 * @param req 요청
 * @returns 토큰 원문 (없으면 undefined)
 */
function sessionToken(req: FastifyRequest): string | undefined {
    const header = req.headers.cookie;
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE)
            return part.slice(eq + 1).trim() || undefined;
    }
    return undefined;
}

/** Origin 검사를 하지 않는 메서드 (상태를 바꾸지 않는다) */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 관리 API 전역 onRequest 훅: 상태를 바꾸는 요청의 Origin 검사 (01_DESIGN 10.4).
 * SameSite=Strict가 다른 사이트 요청에 쿠키를 붙이지 않는 것이 첫 방어선이고, 이 검사가 두 번째다(오래된 브라우저, 같은 사이트의 다른 출처).
 * Origin이 없는 요청(curl, 테스트, 서버 간 호출)은 통과한다 — 브라우저는 이런 요청에 항상 Origin을 붙인다.
 * @param req 요청
 * @returns 없음 (허용되지 않은 Origin은 2003)
 * @author trisakion
 */
export async function originGuard(req: FastifyRequest): Promise<void> {
    if (SAFE_METHODS.has(req.method))
        return;
    const origin = req.headers.origin;
    if (origin !== undefined && !config.admin.origins.includes(origin))
        throw new BusinessException(ApiResult.FORBIDDEN, `origin not allowed: ${origin}`);
}

/**
 * 라우트의 onRequest 훅으로 붙이는 세션 가드. 쿠키 토큰의 해시로 세션을 찾고(요청마다 DB), 역할을 확인한다.
 * - 세션이 없거나 만료·사용중지면 2002. 초기 비밀번호 상태면 비밀번호 변경·me·로그아웃 외에는 1403.
 * - 역할이 모자라면 2003. 상태를 바꾸는 SP는 같은 판단을 FN_GET_ADMIN_ROLE로 다시 한다.
 * @param pool 메인 DB 풀
 * @param minRole 필요한 최소 역할 (codes.AdminRole)
 * @param allowMustChange 초기 비밀번호 상태에서도 허용 (me, 비밀번호 변경, 로그아웃)
 * @returns onRequest 훅. 통과하면 req.admin, req.adminAccountId를 채운다
 * @author trisakion
 */
export function requireRole(pool: Pool, minRole: number, allowMustChange = false): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
    return async (req) => {
        const token = sessionToken(req);
        if (!token)
            throw new BusinessException(ApiResult.UNAUTHORIZED);
        const [row] = await callSpRows(pool, 'SP_GET_ADMIN_SESSION', [hashToken(token), config.admin.sessionIdleMin]);
        if (!row)
            throw new BusinessException(ApiResult.UNAUTHORIZED);
        const admin: AdminIdentity = {
            sessionId: row.admin_session_id, accountId: row.admin_account_id, loginId: row.login_id,
            name: row.display_name, role: row.role, mustChangePassword: row.must_change_password === 1,
        };
        req.admin = admin;
        req.adminAccountId = admin.accountId;
        if (admin.mustChangePassword && !allowMustChange)
            throw new BusinessException(SpResult.ADMIN_PASSWORD_CHANGE_REQUIRED);
        if (admin.role < minRole)
            throw new BusinessException(ApiResult.FORBIDDEN);
    };
}
