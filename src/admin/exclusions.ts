import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { auditBase, withAudit, type AuditWriter } from './audit.js';
import { adminErrors } from './auth.js';
import { requireRole } from './session.js';
import { memberIdSchema } from '../api/ranks.js';
import { AdminRole } from '../core/codes.js';
import { callSp, callSpRows, throwIfSpFailed } from '../core/db.js';
import { reapplyMember } from '../core/exclusion.js';
import { logger } from '../core/logger.js';
import { addExclusions, rankingExclKey, removeExclusions, seasonKeys, type Redis } from '../core/redis.js';

const idParams = { type: 'integer', minimum: 1, maximum: 4294967295, description: '랭킹 ID', example: 12 };
const seasonNoSchema = { type: 'integer', minimum: 0, maximum: 4294967295, description: '시즌 번호 (0: 전 시즌)', example: 3 };
const okSchema = (data: object) => ({ type: 'object', properties: { result: { type: 'integer', example: 0 }, data } });
const redisSyncedSchema = { type: 'boolean', description: 'Redis 제외 집합·순위표를 바로 맞췄는지. false면 리컨실러가 1분 안에 맞춘다', example: true };

const exclusionSchema = {
    type: 'object',
    properties: {
        seasonNo: seasonNoSchema,
        memberId: memberIdSchema,
        reason: { type: 'string', description: '제재 사유', example: 'speed hack' },
        createdBy: { type: 'integer', description: '등록한 계정 ID (0: SYSTEM)', example: 3 },
        createdByName: { type: 'string', description: '등록한 계정의 지금 이름 (등록 당시 이름은 감사 로그)', example: 'GM Kim' },
        createdAt: { type: 'string', format: 'date-time', description: '등록 시각 (UTC)' },
    },
};

/**
 * SP가 돌려준 쉼표 구분 시즌 번호를 배열로 바꾼다.
 * @param s 시즌 번호 목록 ('' 이면 없음)
 * @returns 시즌 번호
 */
function seasonList(s: string): number[] {
    return s.split(',').filter(Boolean).map(Number);
}

/**
 * Redis 작업을 한 번 시도한다. 실패해도 DB는 이미 커밋됐으므로 응답은 성공이고, 리컨실러가 1분 안에 맞춘다 (D-75).
 * @param redis Redis 클라이언트
 * @param label 로그 문구
 * @param work Redis 작업
 * @returns 성공 여부
 */
async function trySync(redis: Redis, label: string, work: () => Promise<void>): Promise<boolean> {
    if (!redis.isReady)
        return false;
    try {
        await work();
        return true;
    } catch (err) {
        logger.warn(`exclusion redis sync failed (reconciler will catch up) ${label}`, err);
        return false;
    }
}

/**
 * 제재 라우트를 등록한다 (01_DESIGN 7.8, 10.4, D-75, D-78). 조회는 viewer, 등록·해제는 operator다.
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 감사 로그 적재기, Redis 클라이언트
 * @author trisakion
 */
export function registerExclusionRoutes(app: FastifyInstance, deps: { pool: Pool; audit: AuditWriter; redis: Redis }): void {
    const { pool, audit, redis } = deps;
    const viewer = requireRole(pool, AdminRole.VIEWER);
    const operator = requireRole(pool, AdminRole.OPERATOR);

    app.get<{ Params: { id: number }; Querystring: { seasonNo?: number; memberId?: string; offset: number; size: number } }>('/admin/v1/rankings/:id/exclusions', {
        onRequest: viewer,
        schema: {
            summary: '제재 목록',
            description: '최신 등록순. `seasonNo`(0: 전 시즌 제재만)와 `memberId`로 거른다. 역할: viewer.',
            tags: ['exclusions'],
            security: [{ session: [] }],
            params: { type: 'object', required: ['id'], properties: { id: idParams } },
            querystring: {
                type: 'object',
                properties: {
                    seasonNo: seasonNoSchema,
                    memberId: memberIdSchema,
                    offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
                    size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '개수 (최대 100)', example: 20 },
                },
            },
            response: {
                200: okSchema({
                    type: 'object',
                    properties: { total: { type: 'integer', description: '조건에 맞는 제재 수', example: 2 }, items: { type: 'array', items: exclusionSchema } },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const q = req.query;
        const rows = await callSpRows(pool, 'SP_LIST_RANKING_EXCLUSION', [req.params.id, q.seasonNo ?? null, q.memberId ?? null, q.offset, q.size]);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.member_id !== null).map((r) => ({
                    seasonNo: r.season_no, memberId: r.member_id, reason: r.reason, createdBy: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at,
                })),
            },
        };
    });

    app.post<{ Params: { id: number }; Body: { seasonNo: number; memberId: string; reason: string } }>('/admin/v1/rankings/:id/exclusions', {
        onRequest: operator,
        schema: {
            summary: '제재 등록',
            description: [
                '멤버를 그 시즌(`seasonNo = 0`이면 전 시즌) 순위에서 뺀다. 역할: operator. 규칙은 01_DESIGN 7.8.',
                '',
                '- 진행 중 시즌: 순위표에서 바로 빠지고, 다시 제출해도 오르지 않는다. 원장에는 기록된다.',
                '- 검수 기간(`review_until`) 전에 등록하면 확정에서 순위가 빠지고 보상은 REJECTED다.',
                '- 검수 뒤 등록하면 순위·보상은 그대로이고 `sanctioned` 표시만 붙는다. 회수는 게임 서버가 한다.',
                '- 아직 만들어지지 않은 시즌은 1602다. 전 시즌(0)으로 건다. 같은 제재가 있으면 1601이다.',
                '- `redisSynced`가 false면 Redis 장애로 순위표 반영이 늦다. 리컨실러가 1분 안에 맞춘다.',
            ].join('\n'),
            tags: ['exclusions'],
            security: [{ session: [] }],
            params: { type: 'object', required: ['id'], properties: { id: idParams } },
            body: {
                type: 'object',
                required: ['seasonNo', 'memberId', 'reason'],
                propertyNames: { enum: ['seasonNo', 'memberId', 'reason'] },
                properties: {
                    seasonNo: seasonNoSchema,
                    memberId: memberIdSchema,
                    reason: { type: 'string', minLength: 1, maxLength: 255, description: '제재 사유 (1~255자)', example: 'speed hack' },
                },
            },
            response: { 200: okSchema({ type: 'object', properties: { ...exclusionSchema.properties, redisSynced: redisSyncedSchema } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const id = req.params.id;
        const b = req.body;
        const row = await withAudit(audit, { ...auditBase(req, admin), action: 'exclusion.create', targetType: 'ranking', targetId: id, after: b }, async (write) => {
            const { result, rows } = await callSp(pool, 'SP_INSERT_RANKING_EXCLUSION', [admin.accountId, id, b.seasonNo, b.memberId, b.reason]);
            write({ result, after: { ...b, seasonStatus: rows[0]?.season_status ?? null } });
            throwIfSpFailed('SP_INSERT_RANKING_EXCLUSION', result);
            return rows[0];
        });
        const boards = seasonList(row.live_seasons).map((n) => seasonKeys(id, n).board);
        const key = b.seasonNo === 0 ? rankingExclKey(id) : seasonKeys(id, b.seasonNo).excl;
        // 순위표가 없는 시즌(정산 이후)에 시즌 집합을 만들면 지울 주체가 없다. 전 시즌 집합은 랭킹에 하나라 항상 둔다.
        const redisSynced = b.seasonNo !== 0 && boards.length === 0
            || await trySync(redis, `ranking=${id} season=${b.seasonNo}`, () => addExclusions(redis, key, [b.memberId], boards));
        return {
            result: 0,
            data: { ...b, createdBy: admin.accountId, createdByName: admin.name, createdAt: row.created_at, redisSynced },
        };
    });

    app.delete<{ Params: { id: number; seasonNo: number; memberId: string } }>('/admin/v1/rankings/:id/exclusions/:seasonNo/:memberId', {
        onRequest: operator,
        schema: {
            summary: '제재 해제',
            description: [
                '역할: operator. 진행 중 시즌이면 원장 값으로 순위표에 다시 오른다.',
                '',
                '- 검수가 끝나기 전(REVIEW까지) 시즌의 제재와 전 시즌(0) 제재만 풀 수 있다. 그 뒤 시즌은 1603이다.',
                '- 이미 붙은 `sanctioned` 표시는 지우지 않는다. 없는 제재는 1604다.',
            ].join('\n'),
            tags: ['exclusions'],
            security: [{ session: [] }],
            params: { type: 'object', required: ['id', 'seasonNo', 'memberId'], properties: { id: idParams, seasonNo: seasonNoSchema, memberId: memberIdSchema } },
            response: { 200: okSchema({ type: 'object', properties: { redisSynced: redisSyncedSchema } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const { id, seasonNo, memberId } = req.params;
        const target = { seasonNo, memberId };
        const row = await withAudit(audit, { ...auditBase(req, admin), action: 'exclusion.delete', targetType: 'ranking', targetId: id, before: target }, async (write) => {
            const { result, rows } = await callSp(pool, 'SP_DELETE_RANKING_EXCLUSION', [admin.accountId, id, seasonNo, memberId]);
            const r = rows[0];
            write({ result, before: r ? { ...target, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at } : target });
            throwIfSpFailed('SP_DELETE_RANKING_EXCLUSION', result);
            return r;
        });
        const live = seasonList(row.live_seasons);
        const key = seasonNo === 0 ? rankingExclKey(id) : seasonKeys(id, seasonNo).excl;
        const redisSynced = seasonNo !== 0 && live.length === 0 || await trySync(redis, `ranking=${id} season=${seasonNo}`, async () => {
            await removeExclusions(redis, key, [memberId]);
            for (const n of live)
                await reapplyMember(pool, redis, id, n, memberId);
        });
        return { result: 0, data: { redisSynced } };
    });
}
