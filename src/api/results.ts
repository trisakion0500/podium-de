import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { requireScope } from './auth.js';
import { errorRef, memberIdSchema, rankingIdParam, rankingOrThrow, readErrors } from './ranks.js';
import { ApiScope, SpResult } from '../core/codes.js';
import { callSp } from '../core/db.js';
import { BusinessException, ERROR_MAP, type ErrorCode } from '../core/errors.js';

/** 결과·Top N 페이지 기본·최대 크기 */
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/** 보상 목록 한 페이지와 ack 한 번의 최대 건수. 대량 처리를 짧은 트랜잭션으로 나눈다 (01_DESIGN 7.7) */
const REWARD_BATCH_MAX = 1000;

const seasonNoParam = { type: 'integer', minimum: 1, maximum: 4294967295, description: '시즌 번호', example: 12 };
const seasonParams = { type: 'object', required: ['id', 'n'], properties: { id: rankingIdParam, n: seasonNoParam } };
const pageQuery = {
    type: 'object',
    properties: {
        offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
        size: { type: 'integer', minimum: 1, maximum: PAGE_SIZE_MAX, default: PAGE_SIZE_DEFAULT, description: `개수 (최대 ${PAGE_SIZE_MAX})`, example: PAGE_SIZE_DEFAULT },
    },
};
const sanctionedSchema = { type: 'boolean', description: 'true: 지급 후 제재됨. 표시 방식은 게임 서버가 정한다', example: false };
const rewardCodeSchema = { type: ['string', 'null'], description: '판정된 보상 코드. 보상 구간 밖이거나 제재면 null', example: 'TOP10' };
const ok = (data: object) => ({ type: 'object', properties: { result: { type: 'integer', description: '0: 성공', example: 0 }, data: { type: 'object', properties: data } } });
const notFinalNote = '- 확정 전(DELIVERING 이전) 시즌은 1003/409, 없는 시즌은 1002/404다.';

/**
 * SP를 부르고 실패 RESULT를 응답 코드로 던진다. ERROR_MAP에 없는 코드는 앱 오류다.
 * @param db 메인 DB 풀
 * @param name SP 이름
 * @param params IN 파라미터
 * @returns 데이터 행
 */
async function rowsOf(db: Pool, name: string, params: unknown[]) {
    const { result, rows } = await callSp(db, name, params);
    if (result !== SpResult.OK) {
        if (!(result in ERROR_MAP))
            throw new Error(`${name}: unmapped result ${result}`);
        throw new BusinessException(result as ErrorCode);
    }
    return rows;
}

/**
 * 지난 시즌 결과와 보상 전달 라우트를 등록한다 (01_DESIGN 7.7, 8.5, 10.2).
 * 결과·Top N은 권한 read, 보상 목록·ack·대기 시즌은 권한 reward. 모두 MySQL에서 읽는다(Redis 없음).
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀
 * @author trisakion
 */
export function registerResultRoutes(app: FastifyInstance, deps: { pool: Pool }): void {
    app.get<{ Params: { id: number; n: number }; Querystring: { offset: number; size: number } }>('/v1/rankings/:id/seasons/:n/results', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '지난 시즌 결과',
            description: [
                '확정된 시즌의 최종 순위를 `offset`부터 `size`개 돌려준다. 권한: read.',
                '',
                '- 제재로 제외된 멤버는 순위가 없어 나오지 않는다. 지급 후 제재된 멤버는 순위를 유지하고 `sanctioned: true`다.',
                '- 백업으로 분리된 오래된 시즌은 빈 목록이다. 시즌별 상위는 `seasons/{n}/top`으로 영구 조회한다.',
                notFinalNote,
            ].join('\n'),
            tags: ['results'],
            security: [{ apiKey: [] }],
            params: seasonParams,
            querystring: pageQuery,
            response: {
                200: ok({
                    participantCount: { type: 'integer', description: '제재 제외 후 확정 참가자 수 (마지막 순위)', example: 2498 },
                    items: {
                        type: 'array',
                        description: '순위 순. 범위를 넘으면 빈 배열',
                        items: {
                            type: 'object',
                            properties: {
                                rank: { type: 'integer', description: '최종 순위 (1부터)', example: 1 },
                                memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
                                score: { type: 'integer', description: '시즌 최종 스코어', example: 1500 },
                                rewardCode: rewardCodeSchema,
                                sanctioned: sanctionedSchema,
                            },
                        },
                    },
                }),
                ...readErrors,
                409: errorRef,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        const rows = await rowsOf(deps.pool, 'SP_LIST_SEASON_RESULT', [req.params.id, req.params.n, req.query.offset, req.query.size]);
        return {
            result: 0,
            data: {
                participantCount: rows[0].participant_count ?? 0,
                items: rows.filter((r) => r.final_rank !== null).map((r) => ({
                    rank: r.final_rank, memberId: r.member_id, score: Number(r.score), rewardCode: r.reward_code, sanctioned: r.sanctioned === 1,
                })),
            },
        };
    });

    app.get<{ Params: { id: number; n: number; memberId: string } }>('/v1/rankings/:id/seasons/:n/results/:memberId', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '지난 시즌 내 결과',
            description: [
                '확정된 시즌에서 한 멤버의 최종 순위와 보상을 돌려준다. 권한: read.',
                '',
                '- 그 시즌 기록이 없으면 오류가 아니라 `rank`, `score`가 null이다. 제재로 제외되면 `rank`만 null이다.',
                notFinalNote,
            ].join('\n'),
            tags: ['results'],
            security: [{ apiKey: [] }],
            params: { type: 'object', required: ['id', 'n', 'memberId'], properties: { id: rankingIdParam, n: seasonNoParam, memberId: memberIdSchema } },
            response: {
                200: ok({
                    memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
                    rank: { type: ['integer', 'null'], description: '최종 순위. 기록이 없거나 제재로 제외되면 null', example: 37 },
                    score: { type: ['integer', 'null'], description: '시즌 최종 스코어. 기록이 없으면 null', example: 1200 },
                    rewardCode: rewardCodeSchema,
                    rewardStatus: {
                        type: 'integer',
                        description: '보상 상태 (0: 보상 없음, 1: 전달 전, 2: 전달 완료, 3: 제재로 미지급)',
                        example: 2,
                    },
                    sanctioned: sanctionedSchema,
                }),
                ...readErrors,
                409: errorRef,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        const [r] = await rowsOf(deps.pool, 'SP_GET_SEASON_RESULT_MEMBER', [req.params.id, req.params.n, req.params.memberId]);
        return {
            result: 0,
            data: {
                memberId: req.params.memberId,
                rank: r?.final_rank ?? null,
                score: r ? Number(r.score) : null,
                rewardCode: r?.reward_code ?? null,
                rewardStatus: r?.reward_status ?? 0,
                sanctioned: r?.sanctioned === 1,
            },
        };
    });

    app.get<{ Params: { id: number; n: number }; Querystring: { offset: number; size: number } }>('/v1/rankings/:id/seasons/:n/top', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '시즌별 Top N',
            description: [
                '시즌 상위 `top_size`명을 영구 보관한 기록을 `offset`부터 `size`개 돌려준다. 권한: read.',
                '',
                '- 확정 전이거나 `top_size`를 넘는 범위는 빈 배열이다.',
            ].join('\n'),
            tags: ['results'],
            security: [{ apiKey: [] }],
            params: seasonParams,
            querystring: pageQuery,
            response: {
                200: ok({
                    items: {
                        type: 'array',
                        description: '순위 순',
                        items: {
                            type: 'object',
                            properties: {
                                rank: { type: 'integer', description: '최종 순위 (1부터)', example: 1 },
                                memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
                                score: { type: 'integer', description: '시즌 최종 스코어', example: 1500 },
                                sanctioned: sanctionedSchema,
                            },
                        },
                    },
                }),
                ...readErrors,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        const rows = await rowsOf(deps.pool, 'SP_LIST_SEASON_TOP', [req.params.id, req.params.n, req.query.offset, req.query.size]);
        return { result: 0, data: { items: rows.map((r) => ({ rank: r.final_rank, memberId: r.member_id, score: Number(r.score), sanctioned: r.sanctioned === 1 })) } };
    });

    app.get<{ Params: { id: number; n: number }; Querystring: { cursor: string; size: number } }>('/v1/rankings/:id/seasons/:n/rewards', {
        onRequest: requireScope(ApiScope.REWARD),
        schema: {
            summary: '보상 전달 대상 목록',
            description: [
                '아직 전달하지 않은 보상(PENDING, 보류 제외)을 `memberId` 오름차순으로 돌려준다. 권한: reward.',
                '',
                '- 우편 발송에 성공한 건만 `rewards/ack`로 알린다. ack가 유실되면 다음 조회에 다시 나온다.',
                '- 중복 발송은 게임 서버가 지급 멱등 키 `(rankingId, seasonNo, memberId)`로 거른다.',
                '- `nextCursor`가 null이면 마지막 페이지다. ack한 건은 목록에서 빠지므로 처음부터 다시 읽어도 된다.',
                '- DELIVERING 전 시즌은 1003/409다. 전달할 시즌은 `/v1/rewards/pending`으로 찾는다.',
            ].join('\n'),
            tags: ['rewards'],
            security: [{ apiKey: [] }],
            params: seasonParams,
            querystring: {
                type: 'object',
                properties: {
                    cursor: { type: 'string', maxLength: 64, default: '', description: '이전 페이지의 nextCursor (처음은 생략)', example: 'user-1001' },
                    size: { type: 'integer', minimum: 1, maximum: REWARD_BATCH_MAX, default: REWARD_BATCH_MAX, description: `개수 (최대 ${REWARD_BATCH_MAX})`, example: REWARD_BATCH_MAX },
                },
            },
            response: {
                200: ok({
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
                                rank: { type: 'integer', description: '최종 순위', example: 3 },
                                score: { type: 'integer', description: '시즌 최종 스코어', example: 1500 },
                                rewardCode: { type: 'string', description: '보상 코드 (게임 서버가 아이템으로 바꾼다)', example: 'TOP10' },
                            },
                        },
                    },
                    nextCursor: { type: ['string', 'null'], description: '다음 페이지 커서. null이면 마지막 페이지', example: 'user-2001' },
                }),
                ...readErrors,
                409: errorRef,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        const { cursor, size } = req.query;
        const rows = await rowsOf(deps.pool, 'SP_LIST_REWARD', [req.params.id, req.params.n, cursor, size]);
        return {
            result: 0,
            data: {
                items: rows.map((r) => ({ memberId: r.member_id, rank: r.final_rank, score: Number(r.score), rewardCode: r.reward_code })),
                nextCursor: rows.length === size ? rows[rows.length - 1].member_id : null,
            },
        };
    });

    app.post<{ Params: { id: number; n: number }; Body: { memberIds: string[] } }>('/v1/rankings/:id/seasons/:n/rewards/ack', {
        onRequest: requireScope(ApiScope.REWARD),
        schema: {
            summary: '보상 전달 완료 (ack)',
            description: [
                '우편 발송에 성공한 멤버를 전달 완료로 기록한다. 권한: reward.',
                '',
                '- 멱등이다. 이미 전달 완료인 멤버는 성공으로 본다. 실패·시간 초과(2005) 시 같은 목록으로 재시도한다.',
                '- 발송 전에 ack하지 않는다. 발송이 실패하면 보상이 유실된다.',
                '- 반영되지 않은 멤버(보류, 제재로 미지급, 보상 없음, 시즌에 없음)는 `notApplied`로 돌려준다.',
                '- 남은 대상이 모두 전달되면 워커가 시즌을 완료(SETTLED)로 넘긴다.',
            ].join('\n'),
            tags: ['rewards'],
            security: [{ apiKey: [] }],
            params: seasonParams,
            body: {
                type: 'object',
                required: ['memberIds'],
                properties: {
                    memberIds: { type: 'array', minItems: 1, maxItems: REWARD_BATCH_MAX, items: memberIdSchema, description: `발송에 성공한 멤버 ID (최대 ${REWARD_BATCH_MAX})`, example: ['user-1001', 'user-1002'] },
                },
            },
            response: {
                200: ok({
                    notApplied: { type: 'array', items: { type: 'string' }, description: '반영되지 않은 멤버 ID. 비어 있으면 전부 반영', example: [] },
                }),
                ...readErrors,
                409: errorRef,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        const rows = await rowsOf(deps.pool, 'SP_UPDATE_REWARD_DELIVERED', [req.params.id, req.params.n, JSON.stringify(req.body.memberIds)]);
        return { result: 0, data: { notApplied: rows.map((r) => r.member_id as string) } };
    });

    app.get('/v1/rewards/pending', {
        onRequest: requireScope(ApiScope.REWARD),
        schema: {
            summary: '전달 대기 시즌',
            description: [
                '보상 전달 중(DELIVERING)인 시즌과 남은 건수를 오래된 시즌부터 돌려준다. 권한: reward.',
                '',
                '- 게임 서버는 이 목록을 주기적으로 확인해 `remaining`이 있는 시즌의 `rewards`를 가져간다. 장애에서 복구하면 밀린 시즌을 위에서부터 처리한다.',
                '- `remaining`이 0인 시즌은 워커가 곧 완료로 넘겨 목록에서 빠진다.',
            ].join('\n'),
            tags: ['rewards'],
            security: [{ apiKey: [] }],
            response: {
                200: ok({
                    seasons: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                rankingId: { type: 'integer', description: '랭킹 ID', example: 1 },
                                seasonNo: { type: 'integer', description: '시즌 번호', example: 12 },
                                endAt: { type: 'string', format: 'date-time', description: '시즌 종료 시각 (UTC)', example: '2026-10-12T00:00:00.000Z' },
                                remaining: { type: 'integer', description: '남은 전달 대상 수', example: 120 },
                            },
                        },
                    },
                }),
                ...readErrors,
            },
        },
    }, async () => {
        const rows = await rowsOf(deps.pool, 'SP_LIST_REWARD_PENDING', []);
        return { result: 0, data: { seasons: rows.map((r) => ({ rankingId: r.ranking_id, seasonNo: r.season_no, endAt: r.end_at, remaining: Number(r.remaining) })) } };
    });
}
