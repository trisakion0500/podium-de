import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { requireRole, type AdminIdentity } from './session.js';
import { AdminRole } from '../core/codes.js';
import { callSp, callSpRows } from '../core/db.js';
import { logger } from '../core/logger.js';
import { maskSensitive } from '../core/server.js';

/**
 * 감사 로그 한 건 (log_admin_audit, 01_DESIGN 10.4)
 * @author trisakion
 */
export interface AuditEntry {
    /** 실행자. 로그인 실패는 대상 계정(없으면 0)과 입력 아이디, 역할 0 */
    actor: { id: number; loginId: string; role: number };
    /** 조작 (예: auth.login, account.create) */
    action: string;
    /** 대상 종류 (account 등) */
    targetType?: string;
    /** 대상 ID */
    targetId?: string | number;
    /** 결과 코드 (0: 성공) */
    result: number;
    /** 변경 전. 비밀 필드는 적재 전에 가린다 */
    before?: object;
    /** 변경 후. 비밀 필드는 적재 전에 가린다 */
    after?: object;
    /** 요청 ID (x-request-id, CLI는 실행마다 새로) */
    requestId: string;
    /** 요청 IP (CLI는 빈 문자열) */
    clientIp: string;
}

/**
 * 감사 로그 적재기. 조작 응답과 분리해 로그 DB 전용 풀로 쓴다 (개발 컨벤션 7장).
 * @author trisakion
 */
export interface AuditWriter {
    /** 한 건을 적재한다. 기다리지 않는다 — 실패해도 조작은 되돌리지 않고 앱 로그에 남긴다 */
    write(entry: AuditEntry): void;
    /** 진행 중인 적재를 기다린다. 종료 때 로그 DB 풀을 닫기 전에 부른다 */
    drain(): Promise<void>;
}

/**
 * 감사 로그 적재기를 만든다. 메인 SP가 커밋된 뒤 부르므로 메인 트랜잭션과 묶이지 않는다.
 * 적재에 실패하면 같은 내용을 앱 로그에 ERROR로 남긴다 — 감사 기록이 어디에도 없는 상태를 만들지 않는다.
 * @param logPool 로그 DB 풀
 * @returns 적재기
 * @author trisakion
 */
export function createAuditWriter(logPool: Pool): AuditWriter {
    const pending = new Set<Promise<void>>();
    return {
        write(entry) {
            const before = entry.before === undefined ? null : JSON.stringify(maskSensitive(entry.before));
            const after = entry.after === undefined ? null : JSON.stringify(maskSensitive(entry.after));
            const params = [entry.actor.id, entry.actor.loginId, entry.actor.role, entry.action, entry.targetType ?? null,
                entry.targetId === undefined ? null : String(entry.targetId), entry.result, before, after, entry.requestId, entry.clientIp];
            const job = callSp(logPool, 'SP_INSERT_LOG_ADMIN_AUDIT', params)
                .then(({ result }) => {
                    if (result !== 0)
                        throw new Error(`SP_INSERT_LOG_ADMIN_AUDIT result ${result}`);
                })
                .catch((err) => logger.error(`[${entry.requestId}] admin audit write failed: ${entry.action} actor=${entry.actor.id} target=${entry.targetType ?? ''}:${entry.targetId ?? ''} result=${entry.result} after=${after ?? ''}`, err))
                .finally(() => pending.delete(job));
            pending.add(job);
        },
        async drain() {
            await Promise.all([...pending]);
        },
    };
}

/**
 * 요청에서 감사 로그 공통 값을 꺼낸다.
 * @param req 요청 (세션 가드를 통과했으면 req.admin이 있다)
 * @param admin 실행자
 * @returns 실행자·요청 ID·IP
 * @author trisakion
 */
export function auditBase(req: FastifyRequest, admin: AdminIdentity): Pick<AuditEntry, 'actor' | 'requestId' | 'clientIp'> {
    return { actor: { id: admin.accountId, loginId: admin.loginId, role: admin.role }, requestId: req.id, clientIp: req.ip };
}

/**
 * 감사 로그 조회 라우트를 등록한다 (GET /admin/v1/audit, ADMIN).
 * 로그 DB SP는 메인 DB 계정을 볼 수 없어 역할 확인은 앱만 한다 (개발 컨벤션 4.2의 로그 DB 예외).
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀(세션 확인), 로그 DB 풀(조회)
 * @author trisakion
 */
export function registerAuditRoutes(app: FastifyInstance, deps: { pool: Pool; logPool: Pool }): void {
    app.get<{ Querystring: { offset: number; size: number; accountId?: number; action?: string } }>('/admin/v1/audit', {
        onRequest: requireRole(deps.pool, AdminRole.ADMIN),
        schema: {
            summary: '감사 로그 조회',
            description: 'GM 조작 감사 로그를 최신순으로 돌려준다. 역할: admin. 비밀 필드는 `***`로 가려져 있다.',
            tags: ['audit'],
            security: [{ session: [] }],
            querystring: {
                type: 'object',
                properties: {
                    offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
                    size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '개수 (최대 100)', example: 20 },
                    accountId: { type: 'integer', minimum: 0, maximum: 4294967295, description: '실행자 계정 ID (0: CLI·없는 아이디 로그인 실패)', example: 1 },
                    action: { type: 'string', minLength: 1, maxLength: 64, description: '조작 (정확히 일치, 예: auth.login)', example: 'account.create' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        result: { type: 'integer', example: 0 },
                        data: {
                            type: 'object',
                            properties: {
                                total: { type: 'integer', description: '필터에 맞는 전체 건수', example: 42 },
                                items: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'integer', description: '감사 로그 ID', example: 101 },
                                            accountId: { type: 'integer', description: '실행자 계정 ID (0: CLI·없는 아이디)', example: 1 },
                                            loginId: { type: 'string', description: '실행자 아이디 스냅샷 (로그인 실패는 입력값)', example: 'gm-kim' },
                                            role: { type: 'integer', description: '실행 시 역할 (0: 미인증, 1: viewer, 2: operator, 3: admin)', example: 3 },
                                            action: { type: 'string', description: '조작', example: 'account.create' },
                                            targetType: { type: ['string', 'null'], description: '대상 종류', example: 'account' },
                                            targetId: { type: ['string', 'null'], description: '대상 ID', example: '7' },
                                            result: { type: 'integer', description: '결과 코드 (0: 성공)', example: 0 },
                                            before: { description: '변경 전 (JSON, 없으면 null)' },
                                            after: { description: '변경 후 (JSON, 없으면 null)' },
                                            requestId: { type: 'string', description: '요청 ID (x-request-id)', example: '3f2c1d9e-…' },
                                            clientIp: { type: 'string', description: '요청 IP (CLI는 빈 문자열)', example: '10.0.0.5' },
                                            createdAt: { type: 'string', format: 'date-time', description: '기록 시각 (UTC)' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (req) => {
        const q = req.query;
        const rows = await callSpRows(deps.logPool, 'SP_LIST_LOG_ADMIN_AUDIT', [q.offset, q.size, q.accountId ?? null, q.action ?? null]);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.log_admin_audit_id !== null).map((r) => ({
                    id: r.log_admin_audit_id, accountId: r.admin_account_id, loginId: r.login_id, role: r.role, action: r.action,
                    targetType: r.target_type, targetId: r.target_id, result: r.result_code, before: r.before_json, after: r.after_json,
                    requestId: r.request_id, clientIp: r.client_ip, createdAt: r.created_at,
                })),
            },
        };
    });
}
