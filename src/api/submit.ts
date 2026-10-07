import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { requireScope } from './auth.js';
import { ApiResult, ApiScope, SortOrder, SpResult, UpdateRule } from '../core/codes.js';
import { callSp } from '../core/db.js';
import { BusinessException, ERROR_MAP, type ErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { composite, getRanking } from './rankings.js';
import { allowSubmit, applyScore, type Redis } from '../core/redis.js';
import { bodyForLog } from '../core/server.js';

/** 제출 이력(log_ranking_submit.rejected)에 남기는 거부 사유. SP 하드 검증 사유와 같은 문자열을 쓴다 */
const REJECTED_REASON: Partial<Record<number, string>> = {
    [SpResult.SCORE_OUT_OF_RANGE]: 'SCORE_RANGE',
    [SpResult.DELTA_EXCEEDED]: 'MAX_DELTA',
    [SpResult.SCORE_MAX_EXCEEDED]: 'SCORE_MAX',
    [ApiResult.TOO_MANY_REQUESTS]: 'RATE_LIMIT',
};

/** 이 라우트의 바디 최대 크기. meta가 로그 DB에 그대로 쌓이므로 기본값(1MiB)보다 작게 둔다 */
const BODY_LIMIT = 16 * 1024;

/** 응답 뒤에 진행 중인 제출 이력 적재. 정상 종료 때 로그 DB 풀을 닫기 전에 기다린다 */
const pendingLogs = new Set<Promise<void>>();

/**
 * 제출 요청 바디
 */
interface SubmitBody {
    memberId: string;
    value: number;
    seasonNo: number;
    requestId: string;
    meta?: Record<string, unknown>;
}

const errorRef = { $ref: 'ErrorResponse#' };

const schema = {
    summary: '스코어 제출',
    description: [
        '게임 서버가 플레이 결과를 제출한다. 권한: write.',
        '',
        '- 같은 `requestId`를 같은 내용으로 다시 보내면 반영하지 않고 현재 상태를 돌려준다(`replayed: true`). 시간 초과(2005)·네트워크 오류 시 같은 `requestId`로 재시도한다.',
        '- `seasonNo`는 플레이 시작 시점의 시즌 번호다. 현재 시즌과 다르면 1103으로 거부한다.',
        '- SUM 랭킹의 첫 제출 증분이 0 이하면 기록하지 않고 `score: 0, version: 0, achievedAt: null`을 돌려준다.',
    ].join('\n'),
    tags: ['scores'],
    security: [{ apiKey: [] }],
    params: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'integer', minimum: 1, maximum: 4294967295, description: '랭킹 ID', example: 1 },
        },
    },
    body: {
        type: 'object',
        required: ['memberId', 'value', 'seasonNo', 'requestId'],
        properties: {
            memberId: { type: 'string', minLength: 1, maxLength: 64, description: '멤버 ID (게임 서버 식별자, 대소문자 구분)', example: 'user-1001' },
            value: {
                type: 'integer',
                minimum: -Number.MAX_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '입력 값. BEST 랭킹은 이번 기록(0 이상), SUM 랭킹은 부호 있는 증분',
                example: 1500,
            },
            seasonNo: { type: 'integer', minimum: 1, maximum: 4294967295, description: '플레이 시작 시점의 시즌 번호 (seasons/current로 조회)', example: 12 },
            requestId: { type: 'string', minLength: 1, maxLength: 64, description: '멱등 키. 제출마다 새로 만들고 재시도에는 같은 값을 쓴다 (대소문자 구분)', example: '7f3c2a10-match-88412' },
            meta: { type: 'object', description: '맥락 정보 (매치 ID 등). 해석하지 않고 제출 이력에만 남긴다', example: { matchId: 'm-88412' } },
        },
    },
    response: {
        200: {
            type: 'object',
            description: '성공 (재전송 포함)',
            properties: {
                result: { type: 'integer', description: '0: 성공', example: 0 },
                data: {
                    type: 'object',
                    properties: {
                        seasonNo: { type: 'integer', description: '반영된 시즌 번호', example: 12 },
                        score: { type: 'integer', description: '처리 후 멤버의 현재 스코어', example: 1500 },
                        achievedAt: { type: ['string', 'null'], format: 'date-time', description: '현재 스코어 달성 시각 (UTC). 기록이 없으면 null', example: '2026-10-07T03:12:45.123Z' },
                        version: { type: 'integer', description: '값 변경 버전. 0이면 기록 없음', example: 3 },
                        replayed: { type: 'boolean', description: 'true: 같은 requestId 재전송이라 반영하지 않고 현재 상태를 돌려줌', example: false },
                    },
                },
            },
        },
        400: errorRef,
        401: errorRef,
        403: errorRef,
        404: errorRef,
        409: errorRef,
        429: errorRef,
        500: errorRef,
        503: errorRef,
    },
};

/**
 * 제출 이력을 로그 DB에 남긴다 (01_DESIGN 4.5). 기다리지 않는다 — 실패해도 응답에 영향이 없고 앱 로그에 같은 내용을 남긴다.
 * @param logPool 로그 DB 풀
 * @param entry 기록할 값 (SP_INSERT_LOG_RANKING_SUBMIT 파라미터 순서)
 */
function writeSubmitLog(logPool: Pool, entry: {
    rankingId: number; seasonNo: number; requestId: string; memberId: string; value: number;
    resultCode: number; replayed: boolean; score: number | null; version: number | null; meta?: Record<string, unknown>;
}): void {
    const params = [
        entry.rankingId, entry.seasonNo, entry.requestId, entry.memberId, entry.value,
        entry.resultCode, REJECTED_REASON[entry.resultCode] ?? null, entry.replayed ? 1 : 0, entry.score, entry.version,
        entry.meta === undefined ? null : JSON.stringify(entry.meta),
    ];
    const write: Promise<void> = callSp(logPool, 'SP_INSERT_LOG_RANKING_SUBMIT', params)
        .then(({ result }) => {
            if (result !== SpResult.OK)
                throw new Error(`result ${result}`);
        })
        // meta는 게임 서버가 보낸 임의 값이라 요청 로그와 같은 마스킹·길이 제한을 거친다 (개발 컨벤션 7.1).
        .catch((err) => logger.warn(`submit log write failed ${bodyForLog(entry)}`, err))
        .finally(() => pendingLogs.delete(write));
    pendingLogs.add(write);
}

/**
 * 진행 중인 제출 이력 적재가 끝날 때까지 기다린다. 정상 종료 때 로그 DB 풀을 닫기 직전에 부른다 —
 * 응답은 이미 나갔지만 적재가 아직 커넥션을 받지 못했다면 풀이 닫히며 유실된다.
 * @returns 완료 Promise (예외를 던지지 않는다)
 * @author trisakion
 */
export async function drainSubmitLogs(): Promise<void> {
    await Promise.allSettled([...pendingLogs]);
}

/**
 * 스코어 제출 라우트를 등록한다 (01_DESIGN 4.1): 빈도 검사(Redis) → SP_SUBMIT_SCORE → Redis 반영 → 제출 이력(로그 DB).
 * Redis와 로그 DB 실패는 응답에 영향이 없다. 원장은 MySQL이며 Redis는 리컨실러가 따라잡는다.
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 로그 DB 풀, Redis 클라이언트
 * @author trisakion
 */
export function registerSubmitRoute(app: FastifyInstance, deps: { pool: Pool; logPool: Pool; redis: Redis }): void {
    app.post<{ Params: { id: number }; Body: SubmitBody }>('/v1/rankings/:id/scores', {
        onRequest: requireScope(ApiScope.WRITE),
        bodyLimit: BODY_LIMIT,
        schema,
    }, async (req) => {
        const rankingId = req.params.id;
        const { memberId, value, seasonNo, requestId, meta } = req.body;
        let resultCode: number = ApiResult.INTERNAL_ERROR;
        let data: { seasonNo: number; score: number; achievedAt: Date | null; version: number; replayed: boolean } | undefined;
        try {
            const rule = getRanking(rankingId);
            if (!rule)
                throw new BusinessException(SpResult.RANKING_NOT_FOUND);
            if (rule.maxSubmitPerMin !== null && !await allowSubmit(deps.redis, rankingId, memberId, rule.maxSubmitPerMin))
                throw new BusinessException(ApiResult.TOO_MANY_REQUESTS);

            const { result, rows } = await callSp(deps.pool, 'SP_SUBMIT_SCORE', [rankingId, seasonNo, memberId, value, requestId]);
            if (result !== SpResult.OK) {
                if (!(result in ERROR_MAP))
                    throw new Error(`SP_SUBMIT_SCORE: unmapped result ${result}`);
                throw new BusinessException(result as ErrorCode);
            }
            const row = rows[0];
            data = {
                seasonNo: row.season_no,
                score: Number(row.score),
                achievedAt: row.achieved_at,
                version: row.version,
                replayed: row.replayed === 1,
            };
            resultCode = SpResult.OK;

            // version 0은 기록이 없다는 뜻이라(D-32) 반영할 값이 없다.
            if (data.version > 0 && data.achievedAt) {
                await applyScore(deps.redis, {
                    rankingId,
                    seasonNo: data.seasonNo,
                    memberId,
                    composite: composite(rule, data.score, data.achievedAt, row.season_start_at),
                    version: data.version,
                    best: rule.updateRule === UpdateRule.BEST,
                    cmp: rule.sortOrder === SortOrder.ASC ? 'LT' : 'GT',
                });
            }
            return { result: 0, data };
        } catch (err) {
            if (err instanceof BusinessException)
                resultCode = err.result;
            // 원장에는 반영됐는데 composite 계산 같은 후처리에서 실패한 경우다. 응답은 성공으로 두고 리컨실러에 맡긴다.
            if (data) {
                logger.error(`[${req.id}] submit post-processing failed`, err);
                return { result: 0, data };
            }
            throw err;
        } finally {
            writeSubmitLog(deps.logPool, {
                rankingId, seasonNo, requestId, memberId, value, meta,
                resultCode,
                replayed: data?.replayed ?? false,
                score: data?.score ?? null,
                version: data?.version ?? null,
            });
        }
    });
}
