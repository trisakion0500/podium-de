import type { Pool } from 'mysql2/promise';
import { SortOrder, SpResult, TimeUnit, UpdateRule } from './codes.js';
import { callSp } from './db.js';
import { startPeriodicLoad } from './refresh.js';

/** 랭킹 정의 재조회 주기. 순위 규칙은 불변이라 늦게 반영되는 것은 제출 빈도 한도와 새 랭킹뿐이다 */
const REFRESH_INTERVAL_MS = 30_000;

/** time_unit 코드 → 밀리초 (codes.TimeUnit) */
const TIME_UNIT_MS: Record<number, number> = {
    [TimeUnit.MS]: 1,
    [TimeUnit.SEC]: 1_000,
    [TimeUnit.MIN]: 60_000,
    [TimeUnit.DAY]: 86_400_000,
};

/**
 * 메모리에 두는 랭킹 정의. API(제출 빈도 검사, composite 계산, 순위 조회)와 워커(복구)가 함께 쓴다 (D-60).
 * 제출 허용 여부(status)는 SP_SUBMIT_SCORE가 원장 기준으로 판정하므로 여기 값으로 거부하지 않는다.
 * @author trisakion
 * @modified 2026-10-09 trisakion api/에서 core/로 이동 — 워커와 같은 계산을 쓰기 위해 (D-60)
 */
export interface RankingRule {
    /** 갱신 규칙 (codes.UpdateRule) — BEST는 ZADD GT/LT, 그 외는 version 비교로 Redis에 반영한다 */
    updateRule: number;
    /** 정렬 방향 (codes.SortOrder) */
    sortOrder: number;
    /** 동점 처리 시간 단위 (codes.TimeUnit) */
    timeUnit: number;
    /** composite의 시간 비트 수 (01_DESIGN 2.4) */
    timeBits: number;
    /** 멤버별 분당 최대 제출 수 (null: 제한 없음) */
    maxSubmitPerMin: number | null;
}

/** ranking_id → 정의. 재조회 때 통째로 바꿔 끼운다 */
let rankings = new Map<number, RankingRule>();

/**
 * 랭킹 정의를 DB에서 읽어 메모리 목록을 바꾼다.
 * @param pool 메인 DB 풀
 * @returns 읽은 랭킹 수
 */
async function load(pool: Pool): Promise<number> {
    const { result, rows } = await callSp(pool, 'SP_LIST_RANKING_DEFINITION', []);
    if (result !== SpResult.OK)
        throw new Error(`SP_LIST_RANKING_DEFINITION result ${result}`);
    rankings = new Map(rows.map((r) => [r.ranking_id as number, {
        updateRule: r.update_rule,
        sortOrder: r.sort_order,
        timeUnit: r.time_unit,
        timeBits: r.time_bits,
        maxSubmitPerMin: r.max_submit_per_min,
    }]));
    return rankings.size;
}

/**
 * 랭킹 정의를 읽고 30초마다 다시 읽는다. 기동 시 읽기 실패는 예외로 던진다.
 * @param pool 메인 DB 풀
 * @param intervalMs 재조회 주기 (테스트용, 기본 30초)
 * @returns 재조회 정지 함수. 정상 종료 때 DB 풀보다 먼저 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export async function startRankingRefresh(pool: Pool, intervalMs = REFRESH_INTERVAL_MS): Promise<() => void> {
    const { stop } = await startPeriodicLoad('ranking definitions', () => load(pool), intervalMs, 'max_submit_per_min changes and new rankings are not applied');
    return stop;
}

/**
 * 메모리의 랭킹 정의를 찾는다. 새로 등록한 랭킹은 다음 재조회(최대 30초)부터 보인다.
 * @param rankingId 랭킹 ID
 * @returns 정의 (없으면 undefined)
 * @author trisakion
 */
export function getRanking(rankingId: number): RankingRule | undefined {
    return rankings.get(rankingId);
}

/**
 * Redis 반영 방식. BEST는 ZADD GT(ASC는 LT), 그 외는 version 비교다 (01_DESIGN 5.3).
 * @param rule 랭킹 정의
 * @returns BEST 여부와 비교 방향
 * @author trisakion
 */
export function applyMode(rule: RankingRule): { best: boolean; cmp: 'GT' | 'LT' } {
    return { best: rule.updateRule === UpdateRule.BEST, cmp: rule.sortOrder === SortOrder.ASC ? 'LT' : 'GT' };
}

/**
 * Redis ZSET score로 쓰는 composite를 계산한다 (01_DESIGN 5.2). 같은 점수면 먼저 달성한 쪽이 위에 오도록
 * 시즌 시작부터의 경과 시간을 하위 비트에 넣는다. 정산 정렬 인덱스(SP_SETTLING_EXCHANGE)의 시간 슬롯과 같은 식이다.
 * 2^53을 넘으면 double이 하위 비트를 잃어 동점 순서가 소리 없이 틀어지므로 예외로 막는다 — 등록 시 비트 예산(2.4) 검사 전까지는 이 검사가 유일한 방어선이다.
 * @param rule 랭킹 정의
 * @param score 스코어
 * @param achievedAt 스코어 달성 시각
 * @param seasonStartAt 시즌 시작 시각
 * @returns composite. 경과 시간이 시간 비트를 벗어나거나 결과가 2^53 이상이면(정의 데이터 이상) 예외
 * @author trisakion
 */
export function composite(rule: RankingRule, score: number, achievedAt: Date, seasonStartAt: Date): number {
    const span = 2 ** rule.timeBits;
    const t = Math.floor((achievedAt.getTime() - seasonStartAt.getTime()) / TIME_UNIT_MS[rule.timeUnit]);
    if (!(t >= 0 && t < span))
        throw new Error(`composite: elapsed ${t} out of time_bits ${rule.timeBits}`);
    const value = score * span + (rule.sortOrder === SortOrder.ASC ? t : span - 1 - t);
    if (!Number.isSafeInteger(value))
        throw new Error(`composite: score ${score} × 2^${rule.timeBits} exceeds 2^53`);
    return value;
}

/**
 * composite에서 스코어를 꺼낸다 (01_DESIGN 5.2 디코드). 시간 부분은 0 ≤ x < 2^time_bits라 정렬 방향과 무관하게 내림 나눗셈이면 된다.
 * @param rule 랭킹 정의
 * @param value Redis ZSET score
 * @returns 스코어
 * @author trisakion
 */
export function decodeScore(rule: RankingRule, value: number): number {
    return Math.floor(value / 2 ** rule.timeBits);
}
