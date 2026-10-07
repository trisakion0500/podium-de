import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ApiResult } from './codes.js';
import { config } from './config.js';
import { BusinessException, ERROR_MAP, type ErrorCode } from './errors.js';
import { logger } from './logger.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** 인증 가드를 통과한 키의 api_credential_id (인증 없는 경로·인증 실패는 null). 로그에는 키 대신 이 값을 남긴다 */
        credentialId: number | null;
    }
}

/**
 * 로그에서 값을 가리는 키 (소문자, 개발 컨벤션 7.1). 새 비밀값 필드가 생기면 여기에 추가한다.
 * x-api-key는 헤더라 지금은 로그에 남기지 않지만, 바디나 헤더 로그가 추가돼도 새지 않게 둔다.
 */
const SENSITIVE_KEYS = new Set([
    'password', 'new_password', 'old_password', 'password_hash', 'phone_number',
    'access_token', 'refresh_token', 'api_secret', 'api_secret_prev',
    'authorization', 'x-api-signature', 'x-api-key',
]);

/** 로그 한 줄의 바디 최대 길이 */
const LOG_BODY_MAX = 5000;

/**
 * 민감 키의 값을 깊이·배열과 무관하게 재귀로 '***'로 바꾼다. 원본은 바꾸지 않는다.
 * @param value 바디 등 임의 값
 * @returns 마스킹한 복사본
 * @author trisakion
 */
export function maskSensitive(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(maskSensitive);
    if (value === null || typeof value !== 'object')
        return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, SENSITIVE_KEYS.has(key.toLowerCase()) ? '***' : maskSensitive(v)]),
    );
}

/**
 * 로그에 남길 바디 문자열. 마스킹 후 직렬화하고 길면 자른다. 요청 바디를 담는 다른 로그 줄(제출 이력 적재 실패 등)도 이 함수를 거친다.
 * @param body 요청 바디 또는 응답 페이로드(JSON 문자열)
 * @returns 로그용 문자열
 * @author trisakion
 */
export function bodyForLog(body: unknown): string {
    let value = body;
    if (typeof body === 'string') {
        try {
            value = JSON.parse(body);
        } catch {
            value = body;
        }
    }
    const text = typeof value === 'string' ? value : JSON.stringify(maskSensitive(value)) ?? '';
    return text.length > LOG_BODY_MAX ? `${text.slice(0, LOG_BODY_MAX)}...(truncated)` : text;
}

/**
 * 실패 응답 바디.
 * @param result 결과 코드
 * @param detail message 뒤에 붙일 상세 (요청 형식 오류의 검증 메시지 등). 내부 정보는 넣지 않는다
 * @returns { result, message }
 */
function errorBody(result: ErrorCode, detail?: string): { result: number; message: string } {
    const { message } = ERROR_MAP[result];
    return { result, message: detail ? `${message} ${detail}` : message };
}

/**
 * Swagger 문서 첫머리의 결과 코드 표. ERROR_MAP에서 만들어 코드 목록이 두 곳에 흩어지지 않게 한다.
 * @returns 마크다운 표
 */
function resultCodeTable(): string {
    const rows = Object.entries(ERROR_MAP).map(([code, e]) => `| ${code} | ${e.httpStatus} | ${e.message} |`);
    return [
        '성공은 `{ result: 0, data }`, 실패는 `{ result, message }`이다. 대역: 10xx~12xx SP, 20xx API 계층, 5000 앱 미분류, 50001 DB.',
        '',
        '| result | HTTP | 의미 |',
        '| --- | --- | --- |',
        ...rows,
    ].join('\n');
}

/**
 * Fastify 인스턴스를 만들고 공통 처리를 붙인다: 요청 ID, 요청/응답 로그(마스킹), 처리 제한 시간,
 * 전역 오류 변환, Swagger(설정 시), /health. 도메인 라우트는 반환된 인스턴스에 등록한 뒤 listen한다.
 * Fastify 자체 로거(pino)는 끈다 — 로그는 log4js 하나로만 남긴다.
 * @returns 라우트 등록 전 Fastify 인스턴스
 * @author trisakion
 * @modified 2026-10-06 trisakion 인증 키 ID(credentialId)를 요청에 선언하고 응답 로그에 추가
 */
export async function buildServer(): Promise<FastifyInstance> {
    // Fastify 요청 처리 순서(아래 훅·핸들러가 끼어드는 위치):
    //   onRequest → (바디 파싱) → preValidation → (스키마 검증) → preHandler → 라우트 핸들러 → (응답 직렬화) → onSend → 전송
    //   중간에 예외가 나면 setErrorHandler, 맞는 라우트가 없으면 setNotFoundHandler가 응답을 만들고, 그 응답도 onSend를 거친다.
    const app = Fastify({
        logger: false,
        // 요청마다 붙는 ID(req.id). 요청 로그와 응답 로그 두 줄을 짝짓는 데 쓴다. 기본값은 인스턴스 안 일련번호라
        // 재시작하면 겹치므로 UUID를 쓴다.
        genReqId: () => randomUUID(),
        // 클라이언트가 보낸 ID를 믿지 않는다 — 인스턴스 로그 안에서 유일해야 짝짓기가 된다.
        requestIdHeader: false,
        // Swagger 문서용 example 키워드를 검증기(ajv strict)가 모르는 키워드로 거부하지 않게 한다.
        ajv: { customOptions: { keywords: ['example'] } },
    });

    // decorateRequest: 요청 객체에 필드를 미리 선언한다. 요청마다 필드를 새로 붙이면 객체 형태가 달라져 V8 최적화가 깨지므로
    // Fastify는 미리 선언하게 한다. 인증 가드(auth.ts)가 채운다.
    app.decorateRequest('credentialId', null);

    // addSchema: 여러 라우트가 함께 쓰는 JSON 스키마를 이름($id)으로 등록한다. 라우트는 { $ref: 'ErrorResponse#' }로
    // 참조해 실패 응답 형식을 한 곳에서만 정의한다. Swagger 문서에는 components.schemas.ErrorResponse로 나온다.
    app.addSchema({
        $id: 'ErrorResponse',
        type: 'object',
        description: '실패 응답',
        properties: {
            result: { type: 'integer', description: '결과 코드 (문서 첫머리 표)', example: 2001 },
            message: { type: 'string', description: '결과 메시지', example: '요청 형식이 올바르지 않습니다.' },
        },
    });

    // addHook: 모든 요청의 특정 단계에 공통 처리를 끼워 넣는다. 라우트마다 같은 코드를 반복하지 않기 위해서다.
    // onRequest: 요청이 들어온 직후(바디 파싱 전). 요청 ID 응답 헤더와 처리 제한 시간 타이머를 건다 —
    // 가장 먼저 시작해야 파싱·검증·핸들러 시간을 모두 제한 시간에 포함한다.
    app.addHook('onRequest', async (req, reply) => {
        // 게임 서버가 문의할 때 이 값을 주면 해당 요청의 로그를 바로 찾는다.
        reply.header('x-request-id', req.id);
        // 시간 초과는 응답만 먼저 보낸다. 진행 중인 SP는 취소되지 않고 커밋될 수 있다(개발 컨벤션 7.2) —
        // 쓰기 API가 멱등 키를 받는 이유다. 이후 핸들러가 응답하려 하면 Fastify가 이미 보낸 응답으로 무시한다.
        const timer = setTimeout(() => {
            if (reply.sent)
                return;
            logger.warn(`[${req.id}] timeout after ${config.apiTimeoutMs}ms`);
            reply.code(ERROR_MAP[ApiResult.TIMEOUT].httpStatus).send(errorBody(ApiResult.TIMEOUT));
        }, config.apiTimeoutMs);
        // close는 정상 완료와 연결 끊김 모두에서 온다.
        reply.raw.once('close', () => clearTimeout(timer));
    });

    // preValidation: 바디 파싱 직후, 스키마 검증 전. 요청 로그(한 줄째)를 남긴다.
    // onRequest에서는 바디가 아직 없고, preHandler에서는 검증에 실패한 요청이 빠지므로 이 단계를 쓴다.
    // 파싱 자체가 실패한 요청(잘못된 JSON 등)은 이 줄 없이 응답 줄만 남는다.
    app.addHook('preValidation', async (req) => {
        logger.info(`[${req.id}] --> ${req.method} ${req.url} ip=${req.ip}${req.body === undefined ? '' : ` body=${bodyForLog(req.body)}`}`);
    });

    // onSend: 응답을 보내기 직전. 응답 로그(두 줄째)를 남긴다. 성공·실패·404·시간 초과 응답이 모두 이 단계를 거치므로
    // 한 곳에서 빠짐없이 남는다. payload는 직렬화된 응답 바디이며, 바꾸지 않고 그대로 돌려줘야 전송된다.
    app.addHook('onSend', async (req, reply, payload) => {
        const body = typeof payload === 'string' ? ` body=${bodyForLog(payload)}` : '';
        const cred = req.credentialId === null ? '' : ` cred=${req.credentialId}`;
        logger.info(`[${req.id}] <-- ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms${cred}${body}`);
        return payload;
    });

    // setErrorHandler: 훅·핸들러·검증에서 던진 모든 예외를 받아 응답으로 바꾸는 전역 처리기(개발 컨벤션 9).
    // 기본 처리기는 Fastify 형식({ statusCode, error, message })과 내부 오류 메시지를 그대로 내보내므로,
    // 여기서 { result, message } 형식으로 통일하고 내부 정보는 로그에만 남긴다.
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof BusinessException) {
            if (err.httpStatus >= 500)
                logger.error(`[${req.id}] ${err.message}`);
            return reply.code(err.httpStatus).send({ result: err.result, message: err.publicMessage });
        }
        // 스키마 검증 실패와 Fastify가 만든 4xx(JSON 파싱, 바디 크기, Content-Type)는 요청 형식 오류다.
        // Fastify 메시지는 요청 자체에 대한 설명이라 내부 정보가 없어 그대로 붙인다.
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
            const message = (err as Error).message;
            return reply.code(ERROR_MAP[ApiResult.VALIDATION_FAILED].httpStatus).send(errorBody(ApiResult.VALIDATION_FAILED, message));
        }
        logger.error(`[${req.id}] unhandled error`, err);
        return reply.code(ERROR_MAP[ApiResult.INTERNAL_ERROR].httpStatus).send(errorBody(ApiResult.INTERNAL_ERROR));
    });

    // setNotFoundHandler: 등록된 라우트와 맞지 않는 요청(경로·메서드)의 응답. 예외가 아니라 setErrorHandler를 거치지 않으므로
    // 따로 지정해 2004 형식으로 맞춘다.
    app.setNotFoundHandler((_req, reply) => {
        reply.code(ERROR_MAP[ApiResult.NOT_FOUND].httpStatus).send(errorBody(ApiResult.NOT_FOUND));
    });

    // register: 플러그인(라우트·훅·설정 묶음)을 붙인다. swagger는 이후 등록되는 라우트의 schema를 모아 OpenAPI 문서를 만들고,
    // swaggerUi는 그 문서를 /docs(화면), /docs/json(원본)으로 연다. 라우트보다 먼저 등록해야 라우트가 문서에 잡힌다.
    if (config.apiDocs) {
        await app.register(swagger, {
            openapi: {
                info: { title: 'Podium DE API', version: config.appVersion, description: resultCodeTable() },
                components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
            },
            // addSchema의 $id를 문서 스키마 이름으로 쓴다 (기본은 def-0 같은 일련번호).
            refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string | undefined) ?? `def-${i}` },
        });
        await app.register(swaggerUi, { routePrefix: '/docs' });
    }

    // get: GET 라우트 등록. schema는 요청 검증, 응답 직렬화(정의된 필드만 내보냄), Swagger 문서에 함께 쓰인다.
    // 서버는 기동 확인을 통과한 뒤에만 만들어지므로 /health 응답 자체가 "확인 통과"를 뜻한다. 인증하지 않는다.
    app.get('/health', {
        schema: {
            summary: '상태 확인',
            description: '로드밸런서·배포 도구용. 기동 확인(스키마 일치, 하트비트)을 통과한 인스턴스만 응답한다. 인증 없음.',
            tags: ['system'],
            response: {
                200: {
                    type: 'object',
                    properties: { result: { type: 'integer', description: '0: 정상', example: 0 } },
                },
            },
        },
    }, async () => ({ result: 0 }));

    return app;
}
