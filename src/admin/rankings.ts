import type { FastifyInstance } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { auditBase, type AuditEntry, type AuditWriter } from './audit.js';
import { adminErrors } from './auth.js';
import { requireRole } from './session.js';
import { AdminRole, ApiResult, CycleType, PartitionTarget, RangeType, RankingStatus, SpResult, TimeUnit } from '../core/codes.js';
import { config } from '../core/config.js';
import { callSp, callSpRows, LockNotAcquiredError, throwIfSpFailed, withLock } from '../core/db.js';
import { BusinessException, type ErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { naturalSeasonEnd, nextSeason, SCHEDULE_LOCK, type SeasonCycle, type SeasonSpan } from '../worker/scheduler.js';

/**
 * 스케줄러 락 대기(초). 요청 처리 제한 시간(API_TIMEOUT_MS, 기본 5초)보다 짧아야 한다 — 길면 2005를 응답한 뒤에 수정이 반영될 수 있다.
 * 스케줄러 한 주기는 보통 수십 ms이고, 파티션 DDL이 MDL을 기다리는 동안만 길어진다.
 */
const SCHEDULE_LOCK_WAIT_SEC = 3;

/** 지운 시즌의 파티션 정리가 스케줄러 락을 기다리는 시간(초). 응답 뒤에 하므로 요청 제한 시간과 무관하다 */
const DROP_LOCK_WAIT_SEC = 60;

/** composite 전체 비트 (01_DESIGN 2.4) */
const COMPOSITE_BITS = 53;

/** 등록·일정 변경의 start_at 최소 여유(ms). API 정의 캐시(30초)와 센티넬 준비(시작 60초 전)를 기다린다 (01_DESIGN 2.7) */
const START_LEAD_MS = 60_000;

/** 시험 계산할 시즌 수. MONTHLY + wait_period가 28일 이후로 밀리는 설정을 찾는 데 충분하다 (2.7, D-67) */
const PLAN_CHECK_SEASONS = 100;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 영구 랭킹이 커버할 최소 기간 (01_DESIGN 2.4) */
const PERMANENT_COVER_MS = Math.ceil(30 * 365.25) * DAY_MS;

/** time_unit 코드 → ms */
const UNIT_MS: Record<number, number> = { [TimeUnit.MS]: 1, [TimeUnit.SEC]: 1000, [TimeUnit.MIN]: 60_000, [TimeUnit.DAY]: DAY_MS };

/** 보상 구간 최대 개수 (01_DESIGN 2.6) */
const MAX_TIERS = 100;

/** 시각 입력 형식. ajv format 플러그인 없이 ISO 8601(시간대 포함)만 받는다 */
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$';

/**
 * 보상 구간 한 행 (ranking_reward_tier, 요청·응답 공통)
 * @author trisakion
 */
export interface Tier {
    tierNo: number;
    /** codes.RangeType */
    rangeType: number;
    rangeFrom: number;
    rangeTo: number;
    rewardCode: string;
}

/**
 * 검증에 쓰는 정의 값 (요청과 수정 전 값을 합친 결과)
 * @author trisakion
 */
export interface DefinitionInput extends SeasonCycle {
    name: string;
    status: number;
    updateRule: number;
    sortOrder: number;
    scoreMax: number;
    timeUnit: number;
    settleDelay: number;
    reviewPeriod: number;
    topSize: number;
    historyRetention: number;
    maxDelta: number | null;
    maxSubmitPerMin: number | null;
    suspicionConfig: object | null;
}

const intSchema = (description: string, example: number, minimum = 0, maximum = 4294967295) => ({ type: 'integer', minimum, maximum, description, example });
const nullableInt = (description: string, example: number) => ({ type: 'integer', nullable: true, minimum: 1, maximum: 4294967295, description, example });
const isoSchema = (description: string, example: string) => ({ type: 'string', pattern: ISO_PATTERN, description, example });

/** suspicion_config 규칙 하나 (01_DESIGN 9.3). 모르는 키는 removeAdditional이 조용히 지우므로 propertyNames로 거부한다 */
const ruleSchema = (extra: Record<string, object>) => ({
    type: 'object',
    required: ['weight', ...Object.keys(extra)],
    propertyNames: { enum: ['weight', ...Object.keys(extra)] },
    properties: { weight: intSchema('가중치', 30, 0, 1000), ...extra },
});

const suspicionSchema = {
    type: 'object',
    nullable: true,
    description: '어뷰징 탐지 규칙 (01_DESIGN 9.3, null: 끔). rules에 없는 규칙은 꺼진 것이다',
    required: ['rules'],
    propertyNames: { enum: ['rules'] },
    properties: {
        rules: {
            type: 'object',
            propertyNames: { enum: ['VELOCITY', 'RANK_JUMP', 'BEST_JUMP', 'REJECTED'] },
            properties: {
                VELOCITY: ruleSchema({ maxPerHour: intSchema('시간당 최대 증분 합 (SUM)', 50000, 1) }),
                RANK_JUMP: ruleSchema({ ranks: intSchema('순위 상승 폭', 1000, 1), withinMinutes: intSchema('기준 시간(분)', 10, 1) }),
                BEST_JUMP: ruleSchema({ ratio: { type: 'number', exclusiveMinimum: 1, description: '직전 최고 대비 배율 (BEST)', example: 5 } }),
                REJECTED: ruleSchema({}),
            },
        },
    },
    example: { rules: { VELOCITY: { weight: 30, maxPerHour: 50000 }, REJECTED: { weight: 10 } } },
};

const tierSchema = {
    type: 'object',
    required: ['tierNo', 'rangeType', 'rangeFrom', 'rangeTo', 'rewardCode'],
    properties: {
        tierNo: intSchema('구간 번호 (랭킹 안에서 유일)', 1, 1, 65535),
        rangeType: { type: 'integer', enum: [1, 2], description: '구간 기준 (1: RANK 순위, 2: PERCENT 제재 제외 참가자 대비 백분율)', example: 1 },
        rangeFrom: intSchema('구간 시작 (포함, 1부터)', 1, 1),
        rangeTo: intSchema('구간 끝 (포함, PERCENT는 100 이하)', 10, 1),
        rewardCode: { type: 'string', minLength: 1, maxLength: 64, description: '보상 코드 (게임 서버가 해석, 대소문자 구분)', example: 'TOP10_BOX' },
    },
};
const tiersSchema = { type: 'array', maxItems: MAX_TIERS, items: tierSchema, description: `보상 구간 (최대 ${MAX_TIERS}개, 01_DESIGN 2.6)` };

/** 등록 후에도 바꿀 수 있는 필드 (01_DESIGN 2.8) */
const mutableProps = {
    name: { type: 'string', minLength: 1, maxLength: 128, description: '랭킹 이름', example: '주간 스테이지 랭킹' },
    timezone: { type: 'string', minLength: 1, maxLength: 64, description: '시즌 경계 시간대 (IANA). 첫 시즌 시작 전까지만 변경', example: 'Asia/Seoul' },
    startAt: isoSchema('랭킹 시작 시각. 지금 + 1분 이후. 첫 시즌 시작 전까지만 변경', '2026-11-02T00:00:00+09:00'),
    endAt: { type: 'string', nullable: true, pattern: ISO_PATTERN, description: '랭킹 종료 시각 (null: 없음). 늘리기는 아직 끝나지 않았을 때만, 줄이기는 지금 이후 시각만', example: '2026-12-28T00:00:00+09:00' },
    cycleType: { type: 'integer', enum: [0, 1, 2, 3, 4], description: '시즌 주기 (0: NONE 반복 없음, 1: DAILY, 2: WEEKLY, 3: MONTHLY 시작일 1~28일, 4: FIXED). 첫 시즌 시작 전까지만 변경', example: 2 },
    cycleValue: nullableInt('FIXED 길이(초). FIXED가 아니면 null', 28800),
    waitPeriod: intSchema('시즌 종료 → 다음 시즌 시작 대기(초). 첫 시즌 시작 전까지만 변경', 0),
    settleDelay: intSchema('시즌 종료 → 정산 시작 유예(초). 수정은 새로 만드는 시즌부터 적용된다(이미 만든 시즌의 settle_at은 그대로)', 600),
    reviewPeriod: intSchema('검수 기간(초)', 86400),
    topSize: intSchema('시즌별 영구 보관 상위 인원', 100, 1, 65535),
    historyRetention: intSchema('시즌 백업 보관 일수 (0: 무기한)', 90),
    maxDelta: { type: 'integer', nullable: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'SUM 1회 최대 증분 (null: 제한 없음)', example: 1000 },
    maxSubmitPerMin: nullableInt('멤버별 분당 최대 제출 수 (null: 제한 없음)', 60),
    suspicionConfig: suspicionSchema,
};

const createProps = {
    rankingCode: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$', description: '랭킹 코드 (영문·숫자·`.`·`_`·`-`, 대소문자 구분, 불변)', example: 'stage-weekly' },
    status: { type: 'integer', enum: [1, 2], default: 1, description: '처음 상태 (1: ACTIVE, 2: PAUSED)', example: 1 },
    updateRule: { type: 'integer', enum: [1, 2], description: '갱신 규칙 (1: BEST 최고 기록, 2: SUM 증분 누적). 불변', example: 1 },
    sortOrder: { type: 'integer', enum: [1, 2], description: '정렬 (1: DESC 큰 값이 위, 2: ASC 작은 값이 위). 불변', example: 1 },
    scoreMax: { type: 'integer', minimum: 1, maximum: 2 ** 52 - 1, description: '스코어 상한 (비트 예산 기준, 불변)', example: 100000000 },
    timeUnit: { type: 'integer', enum: [1, 2, 3, 4], description: '동점 처리 시간 단위 (1: MS, 2: SEC, 3: MIN, 4: DAY). 불변', example: 2 },
    ...mutableProps,
    cycleValue: { ...mutableProps.cycleValue, default: null },
    waitPeriod: { ...mutableProps.waitPeriod, default: 0 },
    topSize: { ...mutableProps.topSize, default: 100 },
    maxDelta: { ...mutableProps.maxDelta, default: null },
    maxSubmitPerMin: { ...mutableProps.maxSubmitPerMin, default: null },
    suspicionConfig: { ...suspicionSchema, default: null },
    endAt: { ...mutableProps.endAt, default: null },
    tiers: { ...tiersSchema, default: [] },
};

const patchProps = { ...mutableProps, status: { type: 'integer', enum: [1, 2, 3], description: '상태 (1: ACTIVE, 2: PAUSED 제출 거부, 3: ENDED 되돌릴 수 없음)', example: 2 } };

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1, maximum: 4294967295, description: '랭킹 ID', example: 12 } } };
const isoOut = (description: string) => ({ type: 'string', format: 'date-time', description });
const isoOutNullable = (description: string) => ({ type: ['string', 'null'], format: 'date-time', description });
const definitionSchema = {
    type: 'object',
    properties: {
        rankingId: { type: 'integer', description: '랭킹 ID (게임 서버 URL에 쓴다)', example: 12 },
        rankingCode: createProps.rankingCode,
        name: mutableProps.name,
        status: patchProps.status,
        updateRule: createProps.updateRule,
        sortOrder: createProps.sortOrder,
        scoreMax: { type: 'integer', description: '스코어 상한', example: 100000000 },
        timeUnit: createProps.timeUnit,
        timeBits: { type: 'integer', description: 'composite 시간 비트 수 (53 − bits(scoreMax))', example: 26 },
        timezone: mutableProps.timezone,
        startAt: isoOut('랭킹 시작 시각 (UTC)'),
        endAt: isoOutNullable('랭킹 종료 시각 (UTC, null: 없음)'),
        cycleType: mutableProps.cycleType,
        cycleValue: { type: ['integer', 'null'], description: 'FIXED 길이(초)' },
        waitPeriod: { type: 'integer', description: '시즌 사이 대기(초)' },
        settleDelay: { type: 'integer', description: '정산 시작 유예(초)' },
        reviewPeriod: { type: 'integer', description: '검수 기간(초)' },
        topSize: { type: 'integer', description: '시즌별 영구 보관 상위 인원' },
        historyRetention: { type: 'integer', description: '시즌 백업 보관 일수 (0: 무기한)' },
        maxDelta: { type: ['integer', 'null'], description: 'SUM 1회 최대 증분 (null: 제한 없음)' },
        maxSubmitPerMin: { type: ['integer', 'null'], description: '멤버별 분당 최대 제출 수 (null: 제한 없음)' },
        suspicionConfig: { type: ['object', 'null'], additionalProperties: true, description: '어뷰징 탐지 규칙 (null: 끔)' },
        tiers: { type: 'array', items: tierSchema, description: '보상 구간' },
        seasons: {
            type: 'array',
            description: '끝나지 않은 시즌 (SCHEDULED·OPEN)',
            items: {
                type: 'object',
                properties: {
                    seasonNo: { type: 'integer', description: '시즌 번호', example: 3 },
                    status: { type: 'integer', description: '1: SCHEDULED, 2: OPEN', example: 2 },
                    startAt: isoOut('시작 (UTC, 포함)'),
                    endAt: isoOut('종료 (UTC, 미포함)'),
                },
            },
        },
        createdAt: isoOut('등록 시각 (UTC)'),
        updatedAt: isoOut('수정 시각 (UTC)'),
    },
};
const okSchema = (data: object) => ({ type: 'object', properties: { result: { type: 'integer', example: 0 }, data } });

/**
 * 검증 실패를 응답 코드와 사유로 던진다.
 * @param code 결과 코드 (2009~2012)
 * @param reason 응답 message 뒤에 붙일 사유 (입력 값만 설명한다)
 * @returns 없음 (항상 예외)
 */
function reject(code: ErrorCode, reason: string): never {
    throw new BusinessException(code, `ranking validation: ${reason}`, { publicDetail: `(${reason})` });
}

/**
 * 조작 하나의 감사 로그를 한 번 남긴다. SP를 부른 뒤에는 작업이 write로 전·후 값과 함께 남기고,
 * 그 전에 앱이 거부하면(검증 2009~2012, 상태 1503, 없음 1501, 락 2013) 여기서 base(요청 값)와 거부 코드로 남긴다.
 * @param audit 감사 로그 적재기
 * @param base 결과 코드를 뺀 감사 로그 값
 * @param work 작업. write는 SP 결과를 남길 때 부른다
 * @returns 작업 결과
 */
async function withAudit<T>(audit: AuditWriter, base: Omit<AuditEntry, 'result'>,
    work: (write: (e: Pick<AuditEntry, 'result' | 'targetId' | 'before' | 'after'>) => void) => Promise<T>): Promise<T> {
    let written = false;
    try {
        return await work((e) => {
            written = true;
            audit.write({ ...base, ...e });
        });
    } catch (err) {
        if (!written && err instanceof BusinessException)
            audit.write({ ...base, result: err.result });
        throw err;
    }
}

/**
 * 정수의 이진 자릿수 (01_DESIGN 2.4의 bits)
 * @param n 1 이상 정수
 * @returns 비트 수
 */
function bits(n: number): number {
    return n.toString(2).length;
}

/**
 * 시간 비트가 담아야 하는 가장 긴 시즌 길이(ms). DST로 하루가 25시간이 되는 경우를 포함한다 (01_DESIGN 2.7).
 * @param d 정의
 * @returns ms
 */
function longestSeasonMs(d: DefinitionInput): number {
    switch (d.cycleType) {
        case CycleType.DAILY: return DAY_MS + HOUR_MS;
        case CycleType.WEEKLY: return 7 * DAY_MS + HOUR_MS;
        case CycleType.MONTHLY: return 31 * DAY_MS + HOUR_MS;
        case CycleType.FIXED: return (d.cycleValue ?? 0) * 1000;
        default: return d.endAt ? d.endAt.getTime() - d.startAt.getTime() : PERMANENT_COVER_MS;
    }
}

/**
 * 정산이 다음 시즌 종료 전에 끝나는지 볼 때 쓰는 가장 짧은 시즌 길이(초). MONTHLY는 가장 짧은 달 28일이다 (01_DESIGN 2.7).
 * @param d 정의 (반복 랭킹)
 * @returns 초
 */
function shortestSeasonSec(d: DefinitionInput): number {
    switch (d.cycleType) {
        case CycleType.DAILY: return 86_400;
        case CycleType.WEEKLY: return 7 * 86_400;
        case CycleType.MONTHLY: return 28 * 86_400;
        default: return d.cycleValue ?? 0;
    }
}

/**
 * 등록 검증 (01_DESIGN 2.4, 2.7). 수정도 바뀐 뒤의 정의로 같은 검증을 한다.
 * @param d 정의
 * @param timeBits 시간 비트 수 (등록은 53 − bits(score_max), 수정은 저장된 값)
 * @param futureStart start_at이 지금 + 1분 이후여야 하는지 (등록, 시즌 일정 변경)
 * @returns 없음 (위반이면 2009~2011)
 * @author trisakion
 */
export function validateDefinition(d: DefinitionInput, timeBits: number, futureStart: boolean): void {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: d.timezone });
    } catch {
        reject(ApiResult.SCHEDULE_INVALID, `알 수 없는 시간대 ${d.timezone}`);
    }
    if ((d.cycleType === CycleType.FIXED) !== (d.cycleValue !== null))
        reject(ApiResult.SCHEDULE_INVALID, 'cycleValue는 FIXED일 때만, 1 이상으로 넣는다');
    if (d.endAt && d.endAt <= d.startAt)
        reject(ApiResult.SCHEDULE_INVALID, 'endAt은 startAt보다 뒤여야 한다');
    if (futureStart && d.startAt.getTime() < Date.now() + START_LEAD_MS)
        reject(ApiResult.SCHEDULE_INVALID, 'startAt은 지금 + 1분 이후여야 한다');

    // 일정 시험 계산: 스케줄러와 같은 함수로 앞 시즌들을 만들어 보고, 거부될 설정(MONTHLY 29~31일 시작 등)을 지금 막는다.
    let last: SeasonSpan | null = null;
    for (let i = 0; i < PLAN_CHECK_SEASONS; i++) {
        try {
            last = nextSeason(d, last);
        } catch (err) {
            // 내부 오류 문구는 응답에 넣지 않는다(errors.ts publicDetail). 원인은 앱 로그에 남긴다.
            logger.warn(`ranking plan check failed: ${(err as Error).message}`);
            reject(ApiResult.SCHEDULE_INVALID, d.cycleType === CycleType.MONTHLY
                ? 'MONTHLY 시즌 시작일이 29~31일이 된다. startAt을 1~28일로 두고 waitPeriod를 확인한다'
                : '시즌 일정을 계산할 수 없다. 주기·시작 시각·대기 기간을 확인한다');
        }
        if (!last)
            break;
    }

    const units = Math.ceil(longestSeasonMs(d) / UNIT_MS[d.timeUnit]);
    if (units > 2 ** timeBits)
        reject(ApiResult.BIT_BUDGET_EXCEEDED, `시즌 길이가 ${units} 단위로 시간 비트 ${timeBits}개(${2 ** timeBits})를 넘는다`);

    if (d.cycleType !== CycleType.NONE) {
        // 정산은 settle_at과 함께 리컨실러 동기화 시각이 end_at + 안전마진을 넘어야 시작한다 (7.1, 6.2).
        const settleStart = Math.max(d.settleDelay, config.recovery.marginSec + Math.ceil(config.recovery.intervalMs / 1000));
        if (settleStart + d.reviewPeriod >= shortestSeasonSec(d))
            reject(ApiResult.SETTLE_PERIOD_TOO_LONG, `정산 시작 지연 ${settleStart}초 + 검수 ${d.reviewPeriod}초 ≥ 시즌 ${shortestSeasonSec(d)}초`);
    }
}

/**
 * 보상 구간 검증 (01_DESIGN 2.6).
 * @param tiers 구간
 * @returns 없음 (위반이면 2012)
 * @author trisakion
 */
export function validateTiers(tiers: Tier[]): void {
    const seen = new Set<number>();
    for (const t of tiers) {
        if (seen.has(t.tierNo))
            reject(ApiResult.REWARD_TIER_INVALID, `tierNo ${t.tierNo} 중복`);
        seen.add(t.tierNo);
        if (t.rangeFrom > t.rangeTo)
            reject(ApiResult.REWARD_TIER_INVALID, `tierNo ${t.tierNo}: rangeFrom > rangeTo`);
        if (t.rangeType === RangeType.PERCENT && t.rangeTo > 100)
            reject(ApiResult.REWARD_TIER_INVALID, `tierNo ${t.tierNo}: PERCENT는 100 이하`);
    }
}

/**
 * SP 행을 정의 값으로 바꾼다.
 * @param r SP_GET_RANKING_DEFINITION 행
 * @returns 정의
 */
function definitionOf(r: RowDataPacket): DefinitionInput {
    return {
        name: r.ranking_name, status: r.status, updateRule: r.update_rule, sortOrder: r.sort_order, scoreMax: Number(r.score_max), timeUnit: r.time_unit,
        timezone: r.timezone, startAt: r.start_at, endAt: r.end_at, cycleType: r.cycle_type, cycleValue: r.cycle_value, waitPeriod: r.wait_period,
        settleDelay: r.settle_delay, reviewPeriod: r.review_period, topSize: r.top_size, historyRetention: r.history_retention,
        maxDelta: r.max_delta === null ? null : Number(r.max_delta), maxSubmitPerMin: r.max_submit_per_min, suspicionConfig: r.suspicion_config,
    };
}

/**
 * 요청 바디의 시각 문자열을 Date로 바꾼다. 형식은 스키마가 이미 확인했다.
 * @param s ISO 8601
 * @returns Date (null은 그대로)
 */
function dateOf(s: string | null): Date | null {
    return s === null ? null : new Date(s);
}

/**
 * 응답용 정의
 * @param r SP_GET_RANKING_DEFINITION 행
 * @returns 응답 data
 */
function definitionData(r: RowDataPacket) {
    return {
        rankingId: r.ranking_id, rankingCode: r.ranking_code, ...definitionOf(r), timeBits: r.time_bits,
        tiers: r.tiers, seasons: r.seasons, createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

/**
 * 감사 로그용 정의 (응답과 같은 필드, 시즌 목록 제외)
 * @param d 정의
 * @returns 감사 로그 JSON
 */
function auditOf(d: DefinitionInput) {
    return { ...d, startAt: d.startAt.toISOString(), endAt: d.endAt?.toISOString() ?? null };
}

/**
 * 지운 시즌의 빈 파티션을 응답 뒤에 지운다 (01_DESIGN 2.8). 파티션 DDL은 MDL을 기다릴 수 있어, 요청 안에서 하면 이미 커밋된 수정이
 * 제한 시간(2005)으로 응답된다. 실패는 경고만 남긴다 — 비어 있고, 같은 번호로 다시 만들면 재사용된다.
 * 스케줄러 락을 다시 잡아 스케줄러가 같은 번호를 다시 만드는 것과 겹치지 않게 한다. 그사이 다시 만들어진 시즌은 SP가 1003으로 거부해 그대로 둔다.
 * @param pool 메인 DB 풀
 * @param rankingId 랭킹 ID
 * @param seasons 지운 시즌 번호 (쉼표 구분)
 * @param requestId 요청 ID (로그용)
 * @returns 없음 (기다리지 않는다)
 */
function dropDeletedPartitions(pool: Pool, rankingId: number, seasons: string, requestId: string): void {
    withLock(pool, SCHEDULE_LOCK, DROP_LOCK_WAIT_SEC, async (conn: PoolConnection) => {
        for (const no of seasons.split(',').filter(Boolean).map(Number))
            for (const target of [PartitionTarget.SUBMIT_KEY, PartitionTarget.ENTRY]) {
                try {
                    const { result } = await callSp(conn, 'SP_PARTITION_DROP', [target, rankingId, no]);
                    if (result !== SpResult.OK && result !== SpResult.SEASON_STATUS_INVALID)
                        throw new Error(`SP_PARTITION_DROP result ${result}`);
                } catch (err) {
                    logger.warn(`[${requestId}] deleted season partition left ranking=${rankingId} season=${no} target=${target}`, err);
                }
            }
    }).catch((err) => logger.warn(`[${requestId}] deleted season partition left ranking=${rankingId} season=${seasons} target=all`, err));
}

/**
 * 랭킹 등록·수정 라우트를 등록한다 (01_DESIGN 2.7, 2.8, 10.4, D-79, D-81). 조회는 viewer, 변경은 operator다.
 * @param app Fastify 인스턴스
 * @param deps 메인 DB 풀, 감사 로그 적재기
 * @author trisakion
 */
export function registerRankingRoutes(app: FastifyInstance, deps: { pool: Pool; audit: AuditWriter }): void {
    const { pool, audit } = deps;
    const viewer = requireRole(pool, AdminRole.VIEWER);
    const operator = requireRole(pool, AdminRole.OPERATOR);

    app.get<{ Querystring: { offset: number; size: number } }>('/admin/v1/rankings', {
        onRequest: viewer,
        schema: {
            summary: '랭킹 목록',
            description: '랭킹을 ID순으로 돌려준다. 역할: viewer.',
            tags: ['rankings'],
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
                        total: { type: 'integer', description: '전체 랭킹 수', example: 3 },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    rankingId: definitionSchema.properties.rankingId, rankingCode: definitionSchema.properties.rankingCode,
                                    name: definitionSchema.properties.name, status: definitionSchema.properties.status,
                                    updateRule: definitionSchema.properties.updateRule, sortOrder: definitionSchema.properties.sortOrder,
                                    cycleType: definitionSchema.properties.cycleType, startAt: definitionSchema.properties.startAt,
                                    endAt: definitionSchema.properties.endAt, updatedAt: definitionSchema.properties.updatedAt,
                                },
                            },
                        },
                    },
                }),
                ...adminErrors,
            },
        },
    }, async (req) => {
        const rows = await callSpRows(pool, 'SP_LIST_RANKING_DEFINITION_PAGE', [req.query.offset, req.query.size]);
        return {
            result: 0,
            data: {
                total: rows[0]?.total_count ?? 0,
                items: rows.filter((r) => r.ranking_id !== null).map((r) => ({
                    rankingId: r.ranking_id, rankingCode: r.ranking_code, name: r.ranking_name, status: r.status, updateRule: r.update_rule,
                    sortOrder: r.sort_order, cycleType: r.cycle_type, startAt: r.start_at, endAt: r.end_at, updatedAt: r.updated_at,
                })),
            },
        };
    });

    app.get<{ Params: { id: number } }>('/admin/v1/rankings/:id', {
        onRequest: viewer,
        schema: {
            summary: '랭킹 조회',
            description: '정의, 보상 구간, 끝나지 않은 시즌(SCHEDULED·OPEN)을 돌려준다. 역할: viewer.',
            tags: ['rankings'],
            security: [{ session: [] }],
            params: idParams,
            response: { 200: okSchema(definitionSchema), ...adminErrors },
        },
    }, async (req) => {
        const [r] = await callSpRows(pool, 'SP_GET_RANKING_DEFINITION', [req.params.id]);
        return { result: 0, data: definitionData(r) };
    });

    app.post<{ Body: Record<string, any> }>('/admin/v1/rankings', {
        onRequest: operator,
        schema: {
            summary: '랭킹 등록',
            description: [
                '정의와 보상 구간을 등록하고 `rankingId`를 돌려준다. 역할: operator.',
                '',
                '- 시즌은 워커 스케줄러가 다음 주기(기본 5초)에 만든다. `startAt`은 지금 + 1분 이후여야 한다.',
                '- 검증(01_DESIGN 2.7): 비트 예산 2009, 일정 2010, 정산 기간 2011, 보상 구간 2012. 사유가 message 뒤에 붙는다.',
                '- `rankingCode` 중복은 1502/409. 모르는 필드는 2001이다.',
                '- 제한 시간(2005) 뒤 다시 보내 1502를 받으면 앞 요청이 등록된 것일 수 있다. 목록에서 `rankingCode`로 찾는다.',
                '- 게임 서버는 응답의 `rankingId`를 설정에 넣는다. 새 랭킹은 API 캐시에 최대 30초 뒤 보인다.',
            ].join('\n'),
            tags: ['rankings'],
            security: [{ session: [] }],
            body: {
                type: 'object',
                required: ['rankingCode', 'name', 'updateRule', 'sortOrder', 'scoreMax', 'timeUnit', 'timezone', 'startAt', 'cycleType', 'settleDelay', 'reviewPeriod', 'historyRetention'],
                propertyNames: { enum: Object.keys(createProps) },
                properties: createProps,
            },
            response: { 200: okSchema({ type: 'object', properties: { rankingId: definitionSchema.properties.rankingId } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const b = req.body;
        const d: DefinitionInput = {
            name: b.name, status: b.status, updateRule: b.updateRule, sortOrder: b.sortOrder, scoreMax: b.scoreMax, timeUnit: b.timeUnit,
            timezone: b.timezone, startAt: new Date(b.startAt), endAt: dateOf(b.endAt), cycleType: b.cycleType, cycleValue: b.cycleValue,
            waitPeriod: b.waitPeriod, settleDelay: b.settleDelay, reviewPeriod: b.reviewPeriod, topSize: b.topSize,
            historyRetention: b.historyRetention, maxDelta: b.maxDelta, maxSubmitPerMin: b.maxSubmitPerMin, suspicionConfig: b.suspicionConfig,
        };
        return withAudit(audit, { ...auditBase(req, admin), action: 'ranking.create', targetType: 'ranking', after: b }, async (write) => {
            // 남는 비트를 모두 시간에 준다(D-81). bits(score_max) ≤ 52는 스키마 상한(2^52 − 1)이 보장한다.
            const timeBits = COMPOSITE_BITS - bits(d.scoreMax);
            validateDefinition(d, timeBits, true);
            validateTiers(b.tiers);
            const { result, rows } = await callSp(pool, 'SP_INSERT_RANKING_DEFINITION', [
                admin.accountId, b.rankingCode, d.name, d.status, d.updateRule, d.sortOrder, d.scoreMax, d.timeUnit, timeBits,
                d.timezone, d.startAt, d.endAt, d.cycleType, d.cycleValue, d.settleDelay, d.waitPeriod, d.reviewPeriod, d.topSize,
                d.historyRetention, d.maxDelta, d.maxSubmitPerMin, d.suspicionConfig === null ? null : JSON.stringify(d.suspicionConfig), JSON.stringify(b.tiers),
            ]);
            const rankingId = rows[0]?.ranking_id;
            write({ result, targetId: rankingId, after: { rankingCode: b.rankingCode, ...auditOf(d), timeBits, tiers: b.tiers } });
            throwIfSpFailed('SP_INSERT_RANKING_DEFINITION', result);
            return { result: 0, data: { rankingId } };
        });
    });

    app.patch<{ Params: { id: number }; Body: Record<string, any> }>('/admin/v1/rankings/:id', {
        onRequest: operator,
        schema: {
            summary: '랭킹 수정',
            description: [
                '보낸 필드만 바뀐다. 역할: operator. 규칙은 01_DESIGN 2.8(D-79).',
                '',
                '- 순위 규칙(`rankingCode`, `updateRule`, `sortOrder`, `scoreMax`, `timeUnit`)은 바꿀 수 없다. 보내면 2001이다.',
                '- 시즌 일정(`timezone`, `startAt`, `cycleType`, `cycleValue`, `waitPeriod`)은 첫 시즌 시작 전까지만(이후 1503).',
                '- `endAt` 줄이기: 지금 이후 시각. 걸친 시즌이 그 시각에 끝난다(진행 중이면 조기 종료). 늘리기: 아직 끝나지 않은 랭킹만.',
                '- `status` 3(ENDED)은 되돌릴 수 없다. 이후 상태·일정·종료 변경은 1503.',
                '- 시즌 스케줄러와 겹치면 2013/503(반영 안 됨, 다시 시도).',
            ].join('\n'),
            tags: ['rankings'],
            security: [{ session: [] }],
            params: idParams,
            body: { type: 'object', minProperties: 1, propertyNames: { enum: Object.keys(patchProps) }, properties: patchProps },
            response: { 200: okSchema(definitionSchema), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const id = req.params.id;
        const b = req.body;
        const deleted = await withAudit(audit, { ...auditBase(req, admin), action: 'ranking.update', targetType: 'ranking', targetId: id, after: b }, async (write) => {
            try {
                return await withLock(pool, SCHEDULE_LOCK, SCHEDULE_LOCK_WAIT_SEC, async (conn) => {
                    // 락을 쥔 뒤에 읽는다. 스케줄러가 시즌을 만들거나 상태를 바꾸지 않으므로 아래 계산이 SP 실행 때까지 맞다.
                    const [cur] = await callSpRows(conn, 'SP_GET_RANKING_DEFINITION', [id]);
                    const before = definitionOf(cur);
                    const d: DefinitionInput = { ...before };
                    for (const [k, v] of Object.entries(b))
                        (d as unknown as Record<string, unknown>)[k] = k === 'startAt' || k === 'endAt' ? dateOf(v) : v;

                    const same = (x: Date | null, y: Date | null) => (x?.getTime() ?? null) === (y?.getTime() ?? null);
                    const scheduleChanged = d.timezone !== before.timezone || !same(d.startAt, before.startAt) || d.cycleType !== before.cycleType
                        || d.cycleValue !== before.cycleValue || d.waitPeriod !== before.waitPeriod;
                    const endChanged = !same(d.endAt, before.endAt);
                    // 상태 거부(1503)가 값 검증(2009~2011)보다 먼저다 — 고칠 값이 아니라 바꿀 수 없는 상태라서다. SP도 다시 본다.
                    const now = Date.now();
                    const locked = (scheduleChanged && before.startAt.getTime() <= now)
                        || (before.status === RankingStatus.ENDED && (d.status !== RankingStatus.ENDED || scheduleChanged || endChanged))
                        || (endChanged && before.endAt !== null && before.endAt.getTime() <= now);
                    if (locked)
                        throw new BusinessException(SpResult.ADMIN_RANKING_LOCKED, `ranking ${id}: locked by state`);
                    // 검증에 쓰는 값을 바꿀 때만 검증한다(2.8). 규칙이 생기기 전 정의나 설정(안전마진)이 바뀐 환경에서도 이름·상태·운영 값은 바뀌어야 한다.
                    if (scheduleChanged || endChanged || d.settleDelay !== before.settleDelay || d.reviewPeriod !== before.reviewPeriod)
                        validateDefinition(d, cur.time_bits, scheduleChanged);

                    // 늘리기: 옛 end_at에서 잘려 있던 마지막 시즌을 새 정의로 다시 계산한다(2.8). 줄이기·종료는 SP가 시각만으로 처리한다.
                    let extend: { seasonNo: number; endAt: Date } | null = null;
                    const extending = before.endAt !== null && (d.endAt === null || d.endAt > before.endAt);
                    if (extending && !scheduleChanged) {
                        const seasons = (cur.seasons as { seasonNo: number; startAt: string; endAt: string }[]);
                        const last = seasons.reduce<(typeof seasons)[number] | null>((a, s) => (!a || s.seasonNo > a.seasonNo ? s : a), null);
                        if (last && new Date(last.endAt).getTime() === before.endAt!.getTime()) {
                            const natural = naturalSeasonEnd(d, new Date(last.startAt));
                            const endAt = d.endAt && d.endAt < natural ? d.endAt : natural;
                            if (endAt > before.endAt!)
                                extend = { seasonNo: last.seasonNo, endAt };
                        }
                    }

                    const { result, rows } = await callSp(conn, 'SP_UPDATE_RANKING_DEFINITION', [
                        admin.accountId, id, d.name, d.status, d.timezone, d.startAt, d.endAt, d.cycleType, d.cycleValue, d.waitPeriod,
                        d.settleDelay, d.reviewPeriod, d.topSize, d.historyRetention, d.maxDelta, d.maxSubmitPerMin,
                        d.suspicionConfig === null ? null : JSON.stringify(d.suspicionConfig), extend?.seasonNo ?? null, extend?.endAt ?? null,
                    ]);
                    const deletedSeasons: string | null = rows[0]?.deleted_seasons ?? null;
                    write({ result, before: auditOf(before), after: { ...auditOf(d), deletedSeasons, extendedSeason: extend } });
                    throwIfSpFailed('SP_UPDATE_RANKING_DEFINITION', result);
                    return deletedSeasons;
                });
            } catch (err) {
                if (err instanceof LockNotAcquiredError)
                    throw new BusinessException(ApiResult.SCHEDULER_BUSY, `ranking update: ${err.message}`);
                throw err;
            }
        });
        if (deleted)
            dropDeletedPartitions(pool, id, deleted, req.id);
        const [after] = await callSpRows(pool, 'SP_GET_RANKING_DEFINITION', [id]);
        return { result: 0, data: definitionData(after) };
    });

    app.put<{ Params: { id: number }; Body: { tiers: Tier[] } }>('/admin/v1/rankings/:id/tiers', {
        onRequest: operator,
        schema: {
            summary: '보상 구간 교체',
            description: [
                '보상 구간 전체를 바꾼다(빈 배열: 보상 없음). 역할: operator.',
                '',
                '- 아직 확정(FINALIZING)에 들어가지 않은 시즌부터 적용된다. 확정은 구간을 시즌에 고정한다(01_DESIGN 7.6).',
                '- 규칙 위반은 2012다(tierNo 중복, rangeFrom > rangeTo, PERCENT 100 초과).',
            ].join('\n'),
            tags: ['rankings'],
            security: [{ session: [] }],
            params: idParams,
            body: { type: 'object', required: ['tiers'], propertyNames: { enum: ['tiers'] }, properties: { tiers: tiersSchema } },
            response: { 200: okSchema({ type: 'object', properties: { tiers: { type: 'array', items: tierSchema, description: '적용된 보상 구간' } } }), ...adminErrors },
        },
    }, async (req) => {
        const admin = req.admin!;
        const after = { tiers: req.body.tiers };
        return withAudit(audit, { ...auditBase(req, admin), action: 'ranking.tiers', targetType: 'ranking', targetId: req.params.id, after }, async (write) => {
            validateTiers(req.body.tiers);
            const { result, rows } = await callSp(pool, 'SP_REPLACE_RANKING_REWARD_TIER', [admin.accountId, req.params.id, JSON.stringify(req.body.tiers)]);
            write({ result, before: rows[0] ? { tiers: rows[0].before_tiers } : undefined, after });
            throwIfSpFailed('SP_REPLACE_RANKING_REWARD_TIER', result);
            return { result: 0, data: after };
        });
    });
}
