import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { auditBase, type AuditWriter } from './audit.js';
import { adminErrors, roleSchema } from './auth.js';
import { generatePassword, hashPassword } from './password.js';
import { requireRole } from './session.js';
import { AdminRole, SpResult } from '../core/codes.js';
import { callSp, callSpRows, throwIfSpFailed } from '../core/db.js';

/**
 * 아이디 형식. 영문·숫자·`.`·`_`·`-`만 쓴다 — 감사 로그와 화면에서 비슷해 보이는 문자(공백, 유니코드 혼동 문자)로 다른 계정을
 * 흉내 내지 못하게 한다. 대소문자는 DB 콜레이션이 무시하므로 `Kim`과 `kim`은 같은 아이디다.
 * @author trisakion
 */
export const LOGIN_ID_PATTERN = '^[A-Za-z0-9._-]{3,64}$';

const statusSchema = { type: 'integer', enum: [1, 2], description: '상태 (1: 활성, 2: 사용중지 — 세션이 모두 끝나고 로그인할 수 없다)', example: 1 };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1, maximum: 4294967295, description: 'GM 계정 ID', example: 7 } } };
const accountSchema = {
    type: 'object',
    properties: {
        accountId: { type: 'integer', description: 'GM 계정 ID', example: 7 },
        loginId: { type: 'string', description: '로그인 아이디', example: 'gm-lee' },
        name: { type: 'string', description: '표시 이름', example: 'Lee' },
        role: roleSchema,
        status: statusSchema,
    },
};
const initialPasswordSchema = { type: 'string', description: '초기 비밀번호 (이 응답에서 한 번만 보인다. 첫 로그인 때 바꿔야 한다)', example: 'q3Zr8kT1mVb0xYw2' };
const okSchema = (data: object) => ({ type: 'object', properties: { result: { type: 'integer', example: 0 }, data } });

/**
 * 응답용 계정
 * @param r SP 결과 행
 * @returns 계정
 */
function accountOf(r: Record<string, unknown>) {
    return { accountId: r.admin_account_id, loginId: r.login_id, name: r.display_name, role: r.role, status: r.status };
}

/**
 * GM 계정 관리 라우트를 등록한다 (01_DESIGN 10.4, D-74). 모두 admin 역할이고, 상태를 바꾸는 SP는 역할을 다시 확인한다.
 * 초기 비밀번호는 서버가 만들어 응답에 한 번만 담는다. 응답 로그에서는 initialPassword가 가려진다(server.ts 마스킹).
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 감사 로그 적재기
 * @author trisakion
 * @modified 2026-10-23 trisakion SP 실패 변환을 db.throwIfSpFailed로 통일
 */
export function registerAccountRoutes(app: FastifyInstance, deps: { pool: Pool; audit: AuditWriter }): void {
    const { pool, audit } = deps;
    const guard = requireRole(pool, AdminRole.ADMIN);

    app.get<{ Querystring: { offset: number; size: number } }>('/admin/v1/accounts', {
        onRequest: guard,
        schema: {
            summary: '계정 목록',
            description: 'GM 계정을 ID순으로 돌려준다. 역할: admin.',
            tags: ['accounts'],
            security: [{ session: [] }],
            querystring: {
                type: 'object',
                properties: {
                    offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
                    size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '개수 (최대 100)', example: 20 },
                },
            },
            response: {
                200: okSchema({
                    type: 'object',
                    properties: {
                        total: { type: 'integer', description: '전체 계정 수', example: 5 },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    ...accountSchema.properties,
                                    mustChangePassword: { type: 'boolean', description: 'true: 초기 비밀번호를 아직 바꾸지 않음', example: false },
                                    locked: { type: 'boolean', description: 'true: 로그인 실패로 잠김 (unlock으로 해제)', example: false },
                                    passwordChangedAt: { type: 'string', format: 'date-time', description: '비밀번호 설정 시각 (UTC)' },
                                    createdAt: { type: 'string', format: 'date-time', description: '생성 시각 (UTC)' },
                                    updatedAt: { type: 'string', format: 'date-time', description: '최종 수정 시각 (UTC)' },
                                },
                            },
                        },
                    },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const rows = await callSpRows(pool, 'SP_LIST_ADMIN_ACCOUNT', [req.query.offset, req.query.size]);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.admin_account_id !== null).map((r) => ({
                    ...accountOf(r), mustChangePassword: r.must_change_password === 1, locked: r.locked === 1,
                    passwordChangedAt: r.password_changed_at, createdAt: r.created_at, updatedAt: r.updated_at,
                })),
            },
        };
    });

    app.post<{ Body: { loginId: string; name: string; role: number } }>('/admin/v1/accounts', {
        onRequest: guard,
        schema: {
            summary: '계정 생성',
            description: [
                '계정을 만들고 초기 비밀번호를 한 번 돌려준다. 역할: admin.',
                '',
                '- 아이디는 영문·숫자·`.`·`_`·`-` 3~64자이며 대소문자를 구분하지 않는다. 중복이면 1407/409.',
                '- 초기 비밀번호는 사람이 전달한다. 첫 로그인 때 바꿔야 한다.',
            ].join('\n'),
            tags: ['accounts'],
            security: [{ session: [] }],
            body: {
                type: 'object',
                required: ['loginId', 'name', 'role'],
                properties: {
                    loginId: { type: 'string', pattern: LOGIN_ID_PATTERN, description: '로그인 아이디', example: 'gm-lee' },
                    name: { type: 'string', minLength: 1, maxLength: 64, description: '표시 이름', example: 'Lee' },
                    role: roleSchema,
                },
            },
            response: { 200: okSchema({ type: 'object', properties: { ...accountSchema.properties, initialPassword: initialPasswordSchema } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const initialPassword = generatePassword();
        const { result, rows } = await callSp(pool, 'SP_INSERT_ADMIN_ACCOUNT',
            [admin.accountId, req.body.loginId, req.body.name, req.body.role, await hashPassword(initialPassword)]);
        const created = rows[0];
        audit.write({ ...auditBase(req, admin), action: 'account.create', targetType: 'account', targetId: created?.admin_account_id, result,
            after: result === SpResult.OK ? accountOf(created) : req.body });
        throwIfSpFailed('SP_INSERT_ADMIN_ACCOUNT', result);
        return { result: 0, data: { ...accountOf(created), initialPassword } };
    });

    app.patch<{ Params: { id: number }; Body: { name?: string; role?: number; status?: number } }>('/admin/v1/accounts/:id', {
        onRequest: guard,
        schema: {
            summary: '계정 수정',
            description: [
                '이름, 역할, 상태를 바꾼다. 보낸 필드만 바뀐다. 역할: admin.',
                '',
                '- 자기 계정의 역할 변경과 사용중지는 1406/400이다(admin이 한 명도 남지 않는 실수 방지).',
                '- 사용중지하면 그 계정의 세션이 모두 끝난다. 역할 변경은 다음 요청부터 적용된다.',
            ].join('\n'),
            tags: ['accounts'],
            security: [{ session: [] }],
            params: idParams,
            body: {
                type: 'object',
                minProperties: 1,
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 64, description: '표시 이름', example: 'Lee' },
                    role: roleSchema,
                    status: statusSchema,
                },
            },
            response: { 200: okSchema(accountSchema), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const { name, role, status } = req.body;
        const { result, rows } = await callSp(pool, 'SP_UPDATE_ADMIN_ACCOUNT', [admin.accountId, req.params.id, name ?? null, role ?? null, status ?? null]);
        const r = rows[0];
        audit.write({ ...auditBase(req, admin), action: 'account.update', targetType: 'account', targetId: req.params.id, result,
            before: r ? { name: r.before_display_name, role: r.before_role, status: r.before_status } : undefined,
            after: r ? { name: r.display_name, role: r.role, status: r.status } : req.body });
        throwIfSpFailed('SP_UPDATE_ADMIN_ACCOUNT', result);
        return { result: 0, data: accountOf(r) };
    });

    app.post<{ Params: { id: number } }>('/admin/v1/accounts/:id/password-reset', {
        onRequest: guard,
        schema: {
            summary: '비밀번호 초기화',
            description: '새 초기 비밀번호를 한 번 돌려준다. 그 계정의 세션이 모두 끝나고 잠금도 풀린다. 역할: admin.',
            tags: ['accounts'],
            security: [{ session: [] }],
            params: idParams,
            response: { 200: okSchema({ type: 'object', properties: { ...accountSchema.properties, initialPassword: initialPasswordSchema } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const initialPassword = generatePassword();
        const { result, rows } = await callSp(pool, 'SP_RESET_ADMIN_PASSWORD', [admin.accountId, req.params.id, await hashPassword(initialPassword)]);
        audit.write({ ...auditBase(req, admin), action: 'account.password_reset', targetType: 'account', targetId: req.params.id, result });
        throwIfSpFailed('SP_RESET_ADMIN_PASSWORD', result);
        return { result: 0, data: { ...accountOf(rows[0]), initialPassword } };
    });

    app.post<{ Params: { id: number } }>('/admin/v1/accounts/:id/unlock', {
        onRequest: guard,
        schema: {
            summary: '잠금 해제',
            description: '로그인 실패로 잠긴 계정을 푼다. 잠기지 않은 계정도 성공이다(실패 횟수만 0으로). 역할: admin.',
            tags: ['accounts'],
            security: [{ session: [] }],
            params: idParams,
            response: { 200: { type: 'object', properties: { result: { type: 'integer', example: 0 } } }, ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const { result } = await callSp(pool, 'SP_UNLOCK_ADMIN_ACCOUNT', [admin.accountId, req.params.id]);
        audit.write({ ...auditBase(req, admin), action: 'account.unlock', targetType: 'account', targetId: req.params.id, result });
        throwIfSpFailed('SP_UNLOCK_ADMIN_ACCOUNT', result);
        return { result: 0 };
    });
}
