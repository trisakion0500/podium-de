import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { requireScope } from './auth.js';
import { ApiScope, SortOrder, SpResult } from '../core/codes.js';
import { BusinessException } from '../core/errors.js';
import { decodeScore, getRanking, type RankingRule } from '../core/rankings.js';
import { getCurrentSeason } from './seasons.js';
import { readBoard, type Redis } from '../core/redis.js';

/** 상위 페이징 기본·최대 크기 */
const TOP_SIZE_DEFAULT = 20;
const TOP_SIZE_MAX = 100;

const errorRef = { $ref: 'ErrorResponse#' };

const rankingIdParam = { type: 'integer', minimum: 1, maximum: 4294967295, description: '랭킹 ID', example: 1 };
const memberIdSchema = { type: 'string', minLength: 1, maxLength: 64, description: '멤버 ID (대소문자 구분)', example: 'user-1001' };
const seasonNoSchema = { type: 'integer', description: '현재 시즌 번호', example: 12 };

/** 순위 행. 순위는 모두 고유하다 — 같은 점수면 먼저 달성한 쪽, 같은 시간 단위 안이면 member 순서로 갈린다 (01_DESIGN 5.2) */
const rankRow = {
    type: 'object',
    properties: {
        rank: { type: 'integer', description: '순위 (1부터)', example: 1 },
        memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
        score: { type: 'integer', description: '스코어', example: 1500 },
    },
};

/** 내 순위. 이번 시즌에 기록이 없으면 rank·score가 null */
const myRank = {
    type: 'object',
    properties: {
        memberId: { type: 'string', description: '멤버 ID', example: 'user-1001' },
        rank: { type: ['integer', 'null'], description: '순위 (1부터). 이번 시즌 기록이 없으면 null', example: 37 },
        score: { type: ['integer', 'null'], description: '스코어. 이번 시즌 기록이 없으면 null', example: 1200 },
    },
};

/** 조회 공통 실패 응답. 503은 2007(집계 중)과 2005(시간 초과) */
const readErrors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 500: errorRef, 503: errorRef };

const unavailableNote = '- 현재 시즌 순위표를 쓸 수 없으면(Redis 장애·재구축 중, 워커 정지) 2007/503이다. 잠시 후 다시 조회한다.';

/**
 * 랭킹 정의를 찾는다. 없으면 제출과 같은 1101로 거부한다.
 * @param rankingId 랭킹 ID
 * @returns 랭킹 정의
 */
function rankingOrThrow(rankingId: number): RankingRule {
    const rule = getRanking(rankingId);
    if (!rule)
        throw new BusinessException(SpResult.RANKING_NOT_FOUND);
    return rule;
}

/**
 * 현재 시즌 순위표를 읽어 응답 형태로 바꾼다.
 * @param deps 메인 DB 풀, Redis 클라이언트
 * @param rankingId 랭킹 ID
 * @param offset 상위 시작 위치 (0부터)
 * @param size 상위 개수 (0이면 상위를 읽지 않는다)
 * @param memberId 순위를 함께 볼 멤버 ('' 이면 생략)
 * @returns 시즌 번호, 상위 행, 멤버 순위
 */
async function readCurrent(deps: { pool: Pool; redis: Redis }, rankingId: number, offset: number, size: number, memberId: string) {
    const rule = rankingOrThrow(rankingId);
    const season = await getCurrentSeason(deps.pool, rankingId);
    const board = await readBoard(deps.redis, {
        rankingId, seasonNo: season.seasonNo, rev: rule.sortOrder === SortOrder.DESC, offset, size, memberId,
    });
    return {
        seasonNo: season.seasonNo,
        items: board.top.map((row, i) => ({ rank: offset + i + 1, memberId: row.memberId, score: decodeScore(rule, row.composite) })),
        me: {
            memberId,
            rank: board.me?.rank ?? null,
            score: board.me ? decodeScore(rule, board.me.composite) : null,
        },
    };
}

/**
 * 순위 조회 라우트를 등록한다 (01_DESIGN 5.4, 10.2): 현재 시즌 정보, 상위 페이징, 내 순위. 권한: read.
 * 현재 시즌은 랭킹별로 end_at까지 메모리에 두고(rankings.getCurrentSeason), 순위는 Redis에서만 읽는다.
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, Redis 클라이언트
 * @author trisakion
 */
export function registerRankRoutes(app: FastifyInstance, deps: { pool: Pool; redis: Redis }): void {
    app.get<{ Params: { id: number } }>('/v1/rankings/:id/seasons/current', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '현재 시즌 정보',
            description: [
                '지금 시각이 [startAt, endAt)에 드는 시즌을 돌려준다. 권한: read.',
                '',
                '- 게임 서버는 이 값을 캐시해 표시와 제출(`seasonNo`)에 쓰고, `endAt`이 지나면 다시 조회한다.',
                '- 시즌 사이 공백이거나 종료된 랭킹이면 1301/404다.',
            ].join('\n'),
            tags: ['rankings'],
            security: [{ apiKey: [] }],
            params: { type: 'object', required: ['id'], properties: { id: rankingIdParam } },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        result: { type: 'integer', description: '0: 성공', example: 0 },
                        data: {
                            type: 'object',
                            properties: {
                                seasonNo: seasonNoSchema,
                                startAt: { type: 'string', format: 'date-time', description: '시즌 시작 시각 (UTC, 포함)', example: '2026-10-05T00:00:00.000Z' },
                                endAt: { type: 'string', format: 'date-time', description: '시즌 종료 시각 (UTC, 미포함)', example: '2026-10-12T00:00:00.000Z' },
                            },
                        },
                    },
                },
                ...readErrors,
            },
        },
    }, async (req) => {
        rankingOrThrow(req.params.id);
        return { result: 0, data: await getCurrentSeason(deps.pool, req.params.id) };
    });

    app.get<{ Params: { id: number }; Querystring: { offset: number; size: number; memberId?: string } }>('/v1/rankings/:id/top', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '현재 시즌 상위 페이징',
            description: [
                '현재 시즌 순위를 `offset`부터 `size`개 돌려준다. 권한: read.',
                '',
                '- `memberId`를 주면 그 멤버의 순위(`me`)를 같은 시점 값으로 함께 돌려준다. 내 순위 API를 따로 부르지 않아도 된다.',
                '- 표시 정보(닉네임 등)는 없다. 게임 서버가 `memberId`로 조합한다.',
                unavailableNote,
            ].join('\n'),
            tags: ['rankings'],
            security: [{ apiKey: [] }],
            params: { type: 'object', required: ['id'], properties: { id: rankingIdParam } },
            querystring: {
                type: 'object',
                properties: {
                    offset: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0, description: '시작 위치 (0부터)', example: 0 },
                    size: { type: 'integer', minimum: 1, maximum: TOP_SIZE_MAX, default: TOP_SIZE_DEFAULT, description: `개수 (최대 ${TOP_SIZE_MAX})`, example: TOP_SIZE_DEFAULT },
                    memberId: { ...memberIdSchema, description: '함께 볼 멤버 ID (선택, 대소문자 구분)' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        result: { type: 'integer', description: '0: 성공', example: 0 },
                        data: {
                            type: 'object',
                            properties: {
                                seasonNo: seasonNoSchema,
                                items: { type: 'array', description: '순위 순. 범위를 넘으면 빈 배열', items: rankRow },
                                me: { ...myRank, description: '`memberId`를 줬을 때만 있다' },
                            },
                        },
                    },
                },
                ...readErrors,
            },
        },
    }, async (req) => {
        const { offset, size, memberId } = req.query;
        const { seasonNo, items, me } = await readCurrent(deps, req.params.id, offset, size, memberId ?? '');
        return { result: 0, data: memberId === undefined ? { seasonNo, items } : { seasonNo, items, me } };
    });

    app.get<{ Params: { id: number; memberId: string } }>('/v1/rankings/:id/members/:memberId', {
        onRequest: requireScope(ApiScope.READ),
        schema: {
            summary: '현재 시즌 내 순위',
            description: [
                '한 멤버의 현재 시즌 순위와 스코어를 돌려준다. 권한: read.',
                '',
                '- 이번 시즌 기록이 없으면 오류가 아니라 `rank: null, score: null`이다.',
                unavailableNote,
            ].join('\n'),
            tags: ['rankings'],
            security: [{ apiKey: [] }],
            params: { type: 'object', required: ['id', 'memberId'], properties: { id: rankingIdParam, memberId: memberIdSchema } },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        result: { type: 'integer', description: '0: 성공', example: 0 },
                        data: { type: 'object', properties: { seasonNo: seasonNoSchema, ...myRank.properties } },
                    },
                },
                ...readErrors,
            },
        },
    }, async (req) => {
        const { seasonNo, me } = await readCurrent(deps, req.params.id, 0, 0, req.params.memberId);
        return { result: 0, data: { seasonNo, ...me } };
    });
}
