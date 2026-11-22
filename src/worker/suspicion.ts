import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { SortOrder, SpResult, UpdateRule } from '../core/codes.js';
import { callSp } from '../core/db.js';
import type { RankingRule } from '../core/rankings.js';
import { readBaselines, writeBaselines, type Baseline, type Redis, type SeasonKeys } from '../core/redis.js';

/** VELOCITY 창 (maxPerHour의 1시간) */
const HOUR_MS = 3_600_000;

/** SP_INSERT_RANKING_SUSPICION 한 번에 넘기는 최대 근거 수 */
const INSERT_MAX = 1000;

/**
 * 근거 한 건 (ranking_suspicion 행)
 * @author trisakion
 */
export interface Hit {
    memberId: string;
    ruleCode: 'VELOCITY' | 'RANK_JUMP' | 'BEST_JUMP';
    weight: number;
    evidence: Record<string, unknown>;
}

/**
 * 판정 결과: 근거와 새로 쓸 기준선
 * @author trisakion
 */
export interface Detection {
    hits: Hit[];
    score: Record<string, string>;
    rank: Record<string, string>;
}

/**
 * 기준선 문자열 "값:시각ms"를 푼다.
 * @param v 기준선 (없으면 null)
 * @returns [값, 시각ms] 또는 null
 */
function parse(v: string | null): [number, number] | null {
    if (v === null)
        return null;
    const [value, at] = v.split(':').map(Number);
    return Number.isFinite(value) && Number.isFinite(at) ? [value, at] : null;
}

/**
 * 이 랭킹에서 리컨실러가 판정할 규칙이 하나라도 켜져 있는가. VELOCITY는 SUM, BEST_JUMP는 BEST에만 적용한다 (01_DESIGN 9.3).
 * @param rule 랭킹 정의
 * @returns 켜져 있으면 true
 * @author trisakion
 */
export function detectsAny(rule: RankingRule): boolean {
    const r = rule.suspicion?.rules;
    if (!r)
        return false;
    return !!r.RANK_JUMP || (rule.updateRule === UpdateRule.SUM && !!r.VELOCITY) || (rule.updateRule === UpdateRule.BEST && !!r.BEST_JUMP);
}

/**
 * 변경분 멤버를 기준선과 비교한다 (01_DESIGN 9.2, D-83). 순수 함수다 — Redis·DB를 건드리지 않는다.
 * - VELOCITY: 기준선 뒤 1시간 안의 증가가 maxPerHour 초과. 1시간이 지나면 기준선을 옮기고 판정하지 않는다.
 *   기준선이 없으면 첫 행(version 1)만 0점 기준으로 본다 — Redis 유실로 기준선만 사라진 기존 멤버를 급등으로 잡지 않는다.
 * - RANK_JUMP: 기준선 순위에서 ranks 이상 상승. 판정한 뒤 withinMinutes가 지났으면 기준선을 옮긴다. 기준선이 없으면 세우기만 한다.
 * - BEST_JUMP: 마지막으로 본 기록 대비 ratio배 (ASC는 1/ratio). 기록이 바뀔 때마다 기준선을 옮긴다.
 * @param rule 랭킹 정의
 * @param nowMs 스캔 시작 DB 시각 T (ms)
 * @param rows 변경분 행 (member_id, score, version)
 * @param bases 멤버 순서대로 기준선
 * @returns 근거와 새 기준선
 * @author trisakion
 */
export function detect(rule: RankingRule, nowMs: number, rows: RowDataPacket[], bases: Baseline[]): Detection {
    const cfg = rule.suspicion?.rules ?? {};
    const velocity = rule.updateRule === UpdateRule.SUM ? cfg.VELOCITY : undefined;
    const bestJump = rule.updateRule === UpdateRule.BEST ? cfg.BEST_JUMP : undefined;
    const rankJump = cfg.RANK_JUMP;
    const out: Detection = { hits: [], score: {}, rank: {} };
    const at = (ms: number) => new Date(ms).toISOString();

    rows.forEach((row, i) => {
        const memberId = row.member_id as string;
        const score = Number(row.score);
        const b = bases[i];

        if (velocity) {
            const base = parse(b.score) ?? (row.version === 1 ? [0, nowMs] as [number, number] : null);
            if (!base || nowMs - base[1] > HOUR_MS)
                out.score[memberId] = `${score}:${nowMs}`;
            else {
                if (b.score === null)
                    out.score[memberId] = `0:${nowMs}`;
                if (score - base[0] > velocity.maxPerHour)
                    out.hits.push({ memberId, ruleCode: 'VELOCITY', weight: velocity.weight,
                        evidence: { fromScore: base[0], toScore: score, fromAt: at(base[1]), maxPerHour: velocity.maxPerHour } });
            }
        }

        if (bestJump) {
            const base = parse(b.score);
            if (base && base[0] > 0 && score !== base[0]) {
                const jumped = rule.sortOrder === SortOrder.ASC ? score * bestJump.ratio <= base[0] : score >= base[0] * bestJump.ratio;
                if (jumped)
                    out.hits.push({ memberId, ruleCode: 'BEST_JUMP', weight: bestJump.weight,
                        evidence: { fromScore: base[0], toScore: score, ratio: bestJump.ratio } });
            }
            if (!base || score !== base[0])
                out.score[memberId] = `${score}:${nowMs}`;
        }

        if (rankJump && b.rankNow !== null) {
            const base = parse(b.rank);
            if (!base)
                out.rank[memberId] = `${b.rankNow}:${nowMs}`;
            else {
                if (base[0] - b.rankNow >= rankJump.ranks)
                    out.hits.push({ memberId, ruleCode: 'RANK_JUMP', weight: rankJump.weight,
                        evidence: { fromRank: base[0] + 1, toRank: b.rankNow + 1, fromAt: at(base[1]), ranks: rankJump.ranks, withinMinutes: rankJump.withinMinutes } });
                if (nowMs - base[1] > rankJump.withinMinutes * 60_000)
                    out.rank[memberId] = `${b.rankNow}:${nowMs}`;
            }
        }
    });
    return out;
}

/**
 * 리컨실러 L2 청크 하나의 소프트 탐지. 기준선을 읽어 판정하고, 근거를 적재한 뒤 기준선을 쓴다 —
 * 적재가 실패하면 기준선을 옮기지 않아 다음 스캔(안전마진 안에서 같은 행을 다시 읽는다)이 다시 판정한다.
 * @param conn 메인 DB 커넥션 (복구 잡 락을 쥔 것)
 * @param redis Redis 클라이언트
 * @param season 랭킹·시즌과 스캔 시작 DB 시각
 * @param rule 랭킹 정의
 * @param keys 시즌 키
 * @param rows 변경분 행 (청크)
 * @returns 적재한 근거 수
 * @author trisakion
 */
export async function scanSuspicion(conn: PoolConnection, redis: Redis, season: { rankingId: number; seasonNo: number; dbNow: Date },
    rule: RankingRule, keys: SeasonKeys, rows: RowDataPacket[]): Promise<number> {
    if (rows.length === 0 || !detectsAny(rule))
        return 0;
    const bases = await readBaselines(redis, keys, rows.map((r) => r.member_id as string), rule.sortOrder !== SortOrder.ASC);
    const d = detect(rule, season.dbNow.getTime(), rows, bases);
    let inserted = 0;
    for (let i = 0; i < d.hits.length; i += INSERT_MAX) {
        const { result, rows: out } = await callSp(conn, 'SP_INSERT_RANKING_SUSPICION', [season.rankingId, season.seasonNo, JSON.stringify(d.hits.slice(i, i + INSERT_MAX))]);
        if (result !== SpResult.OK)
            throw new Error(`SP_INSERT_RANKING_SUSPICION result ${result}`);
        inserted += Number(out[0].inserted);
    }
    await writeBaselines(redis, keys, d.score, d.rank);
    return inserted;
}
