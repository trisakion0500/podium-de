import type { FastifyInstance } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { auditBase, withAudit, type AuditWriter } from './audit.js';
import { adminErrors } from './auth.js';
import { requireRole } from './session.js';
import { memberIdSchema } from '../api/ranks.js';
import { AdminRole } from '../core/codes.js';
import { callSp, callSpRows, throwIfSpFailed } from '../core/db.js';

const okSchema = (data: object) => ({ type: 'object', properties: { result: { type: 'integer', example: 0 }, data } });
const seasonParams = {
    type: 'object',
    required: ['id', 'n'],
    properties: {
        id: { type: 'integer', minimum: 1, maximum: 4294967295, description: '랭킹 ID', example: 12 },
        n: { type: 'integer', minimum: 1, maximum: 4294967295, description: '시즌 번호', example: 3 },
    },
};
const pageQuery = {
    type: 'object',
    properties: {
        offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
        size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '개수 (최대 100)', example: 20 },
    },
};
const statusField = { type: 'integer', description: '시즌 상태 (5: REVIEW, 6: FINALIZING, 7: DELIVERING, 8: SETTLED)', example: 5 };
const holdField = { type: 'integer', description: '검수 보류 (1: 보류, 0: 없음)', example: 1 };
const reviewUntilField = { type: ['string', 'null'], format: 'date-time', description: '검수 종료 시각 (UTC)' };
const changedField = { type: 'boolean', description: '이번 요청이 값을 바꿨는지. false면 이미 그 상태였다 (재시도)', example: true };
const reviewStateSchema = { type: 'object', properties: { status: statusField, reviewHold: holdField, reviewUntil: reviewUntilField, changed: changedField } };

/**
 * 검수 조작 SP의 데이터 행을 응답 값으로 바꾼다.
 * @param r SP 데이터 행
 * @returns 응답 값
 */
function reviewState(r: RowDataPacket): object {
    return { status: r.status, reviewHold: r.review_hold, reviewUntil: r.review_until, changed: r.changed === 1 };
}

/**
 * 검수·전달 조작 라우트를 등록한다 (01_DESIGN 7.5, 7.7, 10.4, D-78, D-82). 조회는 viewer, 조작은 operator다.
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 감사 로그 적재기
 * @author trisakion
 */
export function registerReviewRoutes(app: FastifyInstance, deps: { pool: Pool; audit: AuditWriter }): void {
    const { pool, audit } = deps;
    const viewer = requireRole(pool, AdminRole.VIEWER);
    const operator = requireRole(pool, AdminRole.OPERATOR);

    app.get<{ Querystring: { offset: number; size: number } }>('/admin/v1/seasons/actionable', {
        onRequest: viewer,
        schema: {
            summary: '작업 대기 시즌',
            description: '전 랭킹의 REVIEW·DELIVERING 시즌을 오래된 순으로 돌려준다. GM 조작의 시작점이다. 역할: viewer.',
            tags: ['review'],
            security: [{ session: [] }],
            querystring: pageQuery,
            response: {
                200: okSchema({
                    type: 'object',
                    properties: {
                        total: { type: 'integer', description: '작업 대기 시즌 수', example: 2 },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    rankingId: { type: 'integer', description: '랭킹 ID', example: 12 },
                                    rankingCode: { type: 'string', description: '랭킹 코드', example: 'weekly-pvp' },
                                    rankingName: { type: 'string', description: '랭킹 이름', example: '주간 PvP' },
                                    seasonNo: { type: 'integer', description: '시즌 번호', example: 3 },
                                    status: { type: 'integer', description: '5: REVIEW, 7: DELIVERING', example: 5 },
                                    endAt: { type: 'string', format: 'date-time', description: '시즌 종료 (UTC)' },
                                    reviewUntil: reviewUntilField,
                                    reviewHold: holdField,
                                    remaining: { type: ['integer', 'null'], description: '남은 PENDING 수 (DELIVERING만, REVIEW는 null)', example: 120 },
                                },
                            },
                        },
                    },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const rows = await callSpRows(pool, 'SP_LIST_SEASON_ACTIONABLE', [req.query.offset, req.query.size]);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.ranking_id !== null).map((r) => ({
                    rankingId: r.ranking_id, rankingCode: r.ranking_code, rankingName: r.ranking_name, seasonNo: r.season_no, status: r.status,
                    endAt: r.end_at, reviewUntil: r.review_until, reviewHold: r.review_hold, remaining: r.remaining,
                })),
            },
        };
    });

    app.get<{ Params: { id: number; n: number }; Querystring: { offset: number; size: number } }>('/admin/v1/rankings/:id/seasons/:n/review', {
        onRequest: viewer,
        schema: {
            summary: '검수 목록',
            description: [
                '보상 구간 안에서 어뷰징 포인트나 하드 검증 거부가 있는 멤버를 포인트 내림차순으로 돌려준다. 역할: viewer. 규칙은 01_DESIGN 7.5.',
                '',
                '- REVIEW 시즌만 조회할 수 있다(1701). 없는 시즌은 1002다.',
                '- 포인트는 판정이 아니라 지표다. 제재는 제재 API로 따로 등록한다.',
                '- 순위는 가순위, 보상은 지금 구간 기준의 예상값이다. 제재로 순위가 당겨져 구간에 새로 들어오는 멤버는 나오지 않는다.',
            ].join('\n'),
            tags: ['review'],
            security: [{ session: [] }],
            params: seasonParams,
            querystring: pageQuery,
            response: {
                200: okSchema({
                    type: 'object',
                    properties: {
                        total: { type: 'integer', description: '후보 수', example: 2 },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    memberId: memberIdSchema,
                                    rank: { type: 'integer', description: '가순위', example: 4 },
                                    score: { type: 'number', description: '스코어', example: 7999 },
                                    rewardCode: { type: 'string', description: '예상 보상 코드', example: 'TOP10' },
                                    points: { type: 'integer', description: '이번 시즌 어뷰징 포인트', example: 70 },
                                    previousPoints: { type: 'integer', description: '직전 시즌 어뷰징 포인트 (참고용, 합산하지 않음)', example: 0 },
                                    rejectedCount: { type: 'integer', description: '이번 시즌 하드 검증 거부 횟수', example: 2 },
                                    excluded: { type: 'boolean', description: '이미 제재됐는지 (이 시즌 또는 전 시즌)', example: false },
                                },
                            },
                        },
                    },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const { result, rows } = await callSp(pool, 'SP_LIST_REVIEW_CANDIDATE', [req.params.id, req.params.n, req.query.offset, req.query.size]);
        throwIfSpFailed('SP_LIST_REVIEW_CANDIDATE', result);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.member_id !== null).map((r) => ({
                    memberId: r.member_id, rank: r.final_rank, score: Number(r.score), rewardCode: r.reward_code, points: Number(r.points),
                    previousPoints: Number(r.previous_points), rejectedCount: r.rejected_count, excluded: r.excluded === 1,
                })),
            },
        };
    });

    /**
     * 본문 없는 검수 조작 라우트 하나를 등록한다. 세 조작은 SP와 감사 action만 다르다.
     * @param method HTTP 메서드
     * @param path 시즌 아래 경로
     * @param action 감사 로그 action
     * @param summary Swagger 요약
     * @param description Swagger 설명
     * @param sp SP 이름
     * @param spArgs 요청자·랭킹·시즌 뒤에 붙는 인자
     */
    const reviewAction = (method: 'POST' | 'DELETE', path: string, action: string, summary: string, description: string, sp: string, spArgs: number[]): void => {
        app.route<{ Params: { id: number; n: number } }>({
            method,
            url: `/admin/v1/rankings/:id/seasons/:n/${path}`,
            onRequest: operator,
            schema: {
                summary,
                description,
                tags: ['review'],
                security: [{ session: [] }],
                params: seasonParams,
                response: { 200: okSchema(reviewStateSchema), ...adminErrors },
            },
            handler: async (req) => {
                const admin = req.admin!;
                const { id, n } = req.params;
                const data = await withAudit(audit, { ...auditBase(req, admin), action, targetType: 'season', targetId: `${id}:${n}` }, async (write) => {
                    const { result, rows } = await callSp(pool, sp, [admin.accountId, id, n, ...spArgs]);
                    const state = rows[0] ? reviewState(rows[0]) : undefined;
                    write({ result, after: state });
                    throwIfSpFailed(sp, result);
                    return state;
                });
                return { result: 0, data };
            },
        });
    };

    reviewAction('POST', 'review/hold', 'review.hold', '검수 보류', [
        '해제할 때까지 확정하지 않는다. 역할: operator. 그 시즌 전체의 보상이 늦어진다.',
        '',
        '- REVIEW 시즌만 된다(1701). 이미 보류 중이면 값을 바꾸지 않고 성공한다.',
        '- 보류 중 `review_until`이 `REVIEW_HOLD_WARN_SEC`(기본 24시간)보다 오래 지나면 워커가 경고한다.',
    ].join('\n'), 'SP_UPDATE_SEASON_REVIEW_HOLD', [1]);

    reviewAction('DELETE', 'review/hold', 'review.release', '검수 보류 해제', [
        '역할: operator. `review_until`이 지났으면 지금으로 맞추고, 정산 잡이 다음 주기에 확정한다. 아직 지나지 않았으면 남은 기간을 그대로 둔다.',
        '',
        '- 보류가 없으면 값을 바꾸지 않고 성공한다. 해제 뒤 이미 확정이 시작된 시즌의 재시도도 성공이다.',
    ].join('\n'), 'SP_UPDATE_SEASON_REVIEW_HOLD', [0]);

    reviewAction('POST', 'review/finalize', 'review.finalize', '조기 확정', [
        '검수 기간을 기다리지 않고 끝낸다(`review_until = 지금`). 역할: operator. 확정은 정산 잡이 다음 주기에 한다.',
        '',
        '- 이 시각 전에 등록한 제재만 확정에서 제외된다. 그 뒤의 제재는 표시만 붙는다.',
        '- 보류 중이면 1702다. 먼저 해제한다. 이미 끝난 검수의 재시도는 값을 바꾸지 않고 성공한다.',
    ].join('\n'), 'SP_UPDATE_SEASON_REVIEW_END', []);

    app.post<{ Params: { id: number; n: number }; Body: { reason: string } }>('/admin/v1/rankings/:id/seasons/:n/force-settle', {
        onRequest: operator,
        schema: {
            summary: 'DELIVERING 강제 종료',
            description: [
                '게임 서버가 끝내 가져가지 않는 보상을 포기하고 시즌을 SETTLED로 넘긴다. 되돌릴 수 없다. 역할: operator. 규칙은 01_DESIGN 7.7.',
                '',
                '- 남은 PENDING은 상태를 바꾸지 않고, 백업 분리 잡이 그대로 옮긴다. 보상 목록에는 더 나오지 않는다.',
                '- DELIVERING이 아니면 1703이다. 이미 강제 종료한 시즌의 재시도는 처음 기록을 돌려준다(`changed: false`).',
            ].join('\n'),
            tags: ['review'],
            security: [{ session: [] }],
            params: seasonParams,
            body: {
                type: 'object',
                required: ['reason'],
                propertyNames: { enum: ['reason'] },
                properties: { reason: { type: 'string', minLength: 1, maxLength: 255, description: '강제 종료 사유 (1~255자)', example: 'integration retired' } },
            },
            response: {
                200: okSchema({
                    type: 'object',
                    properties: {
                        forcedBy: { type: 'integer', description: '강제 종료한 계정 ID', example: 3 },
                        forcedReason: { type: 'string', description: '강제 종료 사유', example: 'integration retired' },
                        settledAt: { type: 'string', format: 'date-time', description: '강제 종료 시각 (UTC)' },
                        remaining: { type: ['integer', 'null'], description: '포기한 PENDING 수 (재시도면 null)', example: 120 },
                        changed: changedField,
                    },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const admin = req.admin!;
        const { id, n } = req.params;
        const { reason } = req.body;
        const r = await withAudit(audit, { ...auditBase(req, admin), action: 'season.force_settle', targetType: 'season', targetId: `${id}:${n}`, after: { reason } }, async (write) => {
            const { result, rows } = await callSp(pool, 'SP_UPDATE_SEASON_FORCE_SETTLED', [admin.accountId, id, n, reason]);
            write({ result, after: { reason, remaining: rows[0]?.remaining ?? null, changed: rows[0]?.changed === 1 } });
            throwIfSpFailed('SP_UPDATE_SEASON_FORCE_SETTLED', result);
            return rows[0];
        });
        return {
            result: 0,
            data: { forcedBy: r.forced_by, forcedReason: r.forced_reason, settledAt: r.settled_at, remaining: r.remaining, changed: r.changed === 1 },
        };
    });
}
