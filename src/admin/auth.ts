import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { auditBase, type AuditWriter } from './audit.js';
import { passwordAllowed, hashPassword, verifyDummy, verifyPassword } from './password.js';
import { clearSessionCookie, newSessionToken, requireRole, setSessionCookie, type AdminIdentity } from './session.js';
import { AdminRole, AdminStatus, ApiResult, SpResult } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp, callSpRows } from '../core/db.js';
import { BusinessException } from '../core/errors.js';

/**
 * 실패 응답 스키마 참조 (관리 API 라우트 공용)
 * @author trisakion
 */
export const errorRef = { $ref: 'ErrorResponse#' };

/**
 * 관리 API 공통 실패 응답
 * @author trisakion
 */
export const adminErrors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef, 423: errorRef, 500: errorRef, 503: errorRef };

/**
 * 역할 스키마 (관리 API 공용)
 * @author trisakion
 */
export const roleSchema = { type: 'integer', enum: [1, 2, 3], description: '역할 (1: viewer 조회, 2: operator GM 조작, 3: admin 계정 관리 포함)', example: 2 };

/** 내 계정 응답 */
const meSchema = {
    type: 'object',
    properties: {
        result: { type: 'integer', description: '0: 성공', example: 0 },
        data: {
            type: 'object',
            properties: {
                accountId: { type: 'integer', description: 'GM 계정 ID', example: 1 },
                loginId: { type: 'string', description: '로그인 아이디', example: 'gm-kim' },
                name: { type: 'string', description: '표시 이름', example: 'Kim' },
                role: roleSchema,
                mustChangePassword: { type: 'boolean', description: 'true: 초기 비밀번호. 비밀번호를 바꾸기 전에는 me·비밀번호 변경·로그아웃만 된다', example: false },
            },
        },
    },
};

/**
 * 응답용 내 계정
 * @param a 세션 또는 로그인으로 확인한 계정
 * @returns { result: 0, data }
 */
function meBody(a: Omit<AdminIdentity, 'sessionId'>) {
    return { result: 0, data: { accountId: a.accountId, loginId: a.loginId, name: a.name, role: a.role, mustChangePassword: a.mustChangePassword } };
}

/**
 * 로그인·로그아웃·내 계정·비밀번호 변경 라우트를 등록한다 (01_DESIGN 10.4, D-74).
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 감사 로그 적재기
 * @author trisakion
 */
export function registerAuthRoutes(app: FastifyInstance, deps: { pool: Pool; audit: AuditWriter }): void {
    const { pool, audit } = deps;

    app.post<{ Body: { loginId: string; password: string } }>('/admin/v1/auth/login', {
        schema: {
            summary: '로그인',
            description: [
                '성공하면 세션 쿠키(`__Host-podium_admin`, HttpOnly·Secure·SameSite=Strict)를 준다.',
                '',
                '- 아이디가 없거나, 비밀번호가 틀리거나, 사용중지된 계정은 모두 1401/401이다(어느 쪽인지 알리지 않는다).',
                '- 연속 5회 틀리면 15분 잠기고, 잠긴 동안은 비밀번호가 맞아도 1402/423이다. admin이 잠금을 풀 수 있다.',
                '- `mustChangePassword: true`면 비밀번호를 먼저 바꿔야 한다.',
            ].join('\n'),
            tags: ['auth'],
            body: {
                type: 'object',
                required: ['loginId', 'password'],
                properties: {
                    loginId: { type: 'string', minLength: 1, maxLength: 64, description: '로그인 아이디', example: 'gm-kim' },
                    password: { type: 'string', minLength: 1, maxLength: 128, description: '비밀번호', example: 'correct-horse-battery' },
                },
            },
            response: { 200: meSchema, ...adminErrors },
        },
    }, async (req, reply) => {
        const { loginId, password } = req.body;
        const fail = (code: number, accountId = 0): never => {
            audit.write({ actor: { id: accountId, loginId, role: 0 }, action: 'auth.login', targetType: 'account', targetId: accountId || undefined, result: code, requestId: req.id, clientIp: req.ip });
            throw new BusinessException(code === SpResult.ADMIN_LOCKED ? SpResult.ADMIN_LOCKED : SpResult.ADMIN_LOGIN_FAILED);
        };
        const [acc] = await callSpRows(pool, 'SP_GET_ADMIN_LOGIN', [loginId]);
        if (!acc) {
            await verifyDummy(password);
            return fail(SpResult.ADMIN_LOGIN_FAILED);
        }
        // 잠긴 동안은 비교하지 않고 같은 코드를 준다. 비밀번호가 맞을 때만 다른 코드를 주면 잠금 중에도 대입을 계속할 수 있다.
        if (acc.locked === 1)
            return fail(SpResult.ADMIN_LOCKED, acc.admin_account_id);
        const matched = await verifyPassword(password, acc.password_hash);
        if (!matched) {
            const [state] = await callSpRows(pool, 'SP_UPDATE_ADMIN_LOGIN_FAIL', [acc.admin_account_id]);
            return fail(state?.locked_until ? SpResult.ADMIN_LOCKED : SpResult.ADMIN_LOGIN_FAILED, acc.admin_account_id);
        }
        if (acc.status !== AdminStatus.ACTIVE)
            return fail(SpResult.ADMIN_LOGIN_FAILED, acc.admin_account_id);

        const { token, hash } = newSessionToken();
        const { result } = await callSp(pool, 'SP_INSERT_ADMIN_SESSION',
            [acc.admin_account_id, acc.password_hash, hash, req.ip, config.admin.sessionIdleMin, config.admin.sessionMaxHours]);
        if (result !== SpResult.OK)
            return fail(result, acc.admin_account_id);
        setSessionCookie(reply, token);
        req.adminAccountId = acc.admin_account_id;
        const me = { accountId: acc.admin_account_id, loginId: acc.login_id, name: acc.display_name, role: acc.role, mustChangePassword: acc.must_change_password === 1 };
        audit.write({ actor: { id: me.accountId, loginId: me.loginId, role: me.role }, action: 'auth.login', targetType: 'account', targetId: me.accountId, result: 0, requestId: req.id, clientIp: req.ip });
        return meBody(me);
    });

    app.post('/admin/v1/auth/logout', {
        onRequest: requireRole(pool, AdminRole.VIEWER, true),
        schema: {
            summary: '로그아웃',
            description: '현재 세션을 지우고 쿠키를 지운다. 다른 곳에서 연 세션은 그대로다.',
            tags: ['auth'],
            security: [{ session: [] }],
            response: { 200: { type: 'object', properties: { result: { type: 'integer', example: 0 } } }, ...adminErrors },
        },
    }, async (req, reply) => {
        const admin = req.admin!;
        await callSpRows(pool, 'SP_DELETE_ADMIN_SESSION', [admin.sessionId]);
        clearSessionCookie(reply);
        audit.write({ ...auditBase(req, admin), action: 'auth.logout', result: 0 });
        return { result: 0 };
    });

    app.get('/admin/v1/auth/me', {
        onRequest: requireRole(pool, AdminRole.VIEWER, true),
        schema: {
            summary: '내 계정',
            description: '세션의 계정과 역할. 역할은 요청마다 계정에서 읽으므로 바뀌면 바로 반영된다.',
            tags: ['auth'],
            security: [{ session: [] }],
            response: { 200: meSchema, ...adminErrors },
        },
    }, async (req) => meBody(req.admin!));

    app.post<{ Body: { currentPassword: string; newPassword: string } }>('/admin/v1/auth/password', {
        onRequest: requireRole(pool, AdminRole.VIEWER, true),
        schema: {
            summary: '비밀번호 변경',
            description: [
                '본인 비밀번호를 바꾼다. 다른 곳에서 연 세션은 모두 끝나고, 이 요청에는 새 세션 쿠키를 준다.',
                '',
                '- 새 비밀번호는 12~128자이고 아이디와 달라야 한다(2008/400). 문자 조합 규칙은 없다.',
                '- 현재 비밀번호가 틀리면 1401/401이며 로그인 실패 횟수에 들어간다.',
            ].join('\n'),
            tags: ['auth'],
            security: [{ session: [] }],
            body: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                    currentPassword: { type: 'string', minLength: 1, maxLength: 128, description: '현재 비밀번호', example: 'initial-password' },
                    newPassword: { type: 'string', minLength: 1, maxLength: 512, description: '새 비밀번호 (12~128자)', example: 'correct-horse-battery' },
                },
            },
            response: { 200: meSchema, ...adminErrors },
        },
    }, async (req, reply) => {
        const admin = req.admin!;
        const base = { ...auditBase(req, admin), action: 'auth.password', targetType: 'account', targetId: admin.accountId };
        if (!passwordAllowed(req.body.newPassword, admin.loginId))
            throw new BusinessException(ApiResult.PASSWORD_POLICY);
        const [acc] = await callSpRows(pool, 'SP_GET_ADMIN_LOGIN', [admin.loginId]);
        // 잠긴 동안은 비교하지 않는다. 잠긴 동안은 실패 횟수도 늘지 않아, 비교를 하면 현재 비밀번호를 제한 없이 대입할 수 있다.
        if (acc?.locked === 1) {
            audit.write({ ...base, result: SpResult.ADMIN_LOCKED });
            throw new BusinessException(SpResult.ADMIN_LOCKED);
        }
        if (!acc || !(await verifyPassword(req.body.currentPassword, acc.password_hash))) {
            // 세션을 가진 사람의 현재 비밀번호 대입도 로그인 실패와 같은 한도로 막는다.
            if (acc)
                await callSpRows(pool, 'SP_UPDATE_ADMIN_LOGIN_FAIL', [acc.admin_account_id]);
            audit.write({ ...base, result: SpResult.ADMIN_LOGIN_FAILED });
            throw new BusinessException(SpResult.ADMIN_LOGIN_FAILED);
        }
        const newHash = await hashPassword(req.body.newPassword);
        const { token, hash } = newSessionToken();
        const { result } = await callSp(pool, 'SP_UPDATE_ADMIN_PASSWORD', [admin.accountId, acc.password_hash, newHash, hash, req.ip, config.admin.sessionMaxHours]);
        audit.write({ ...base, result });
        if (result !== SpResult.OK)
            throw new BusinessException(result === SpResult.ADMIN_FORBIDDEN || result === SpResult.ADMIN_LOCKED ? result : SpResult.ADMIN_LOGIN_FAILED);
        setSessionCookie(reply, token);
        return meBody({ ...admin, mustChangePassword: false });
    });
}
