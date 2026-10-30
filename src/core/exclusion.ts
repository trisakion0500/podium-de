import type { Pool, PoolConnection } from 'mysql2/promise';
import { SpResult } from './codes.js';
import { callSp } from './db.js';
import { applyMode, composite, type RankingRule } from './rankings.js';
import { reconcileScore, seasonKeys, type Redis } from './redis.js';

/**
 * 제재가 풀린 멤버를 원장 값으로 순위표에 다시 반영한다 (01_DESIGN 7.8, D-75). 관리 API의 해제와 복구 잡의 제외 집합 동기화가 쓴다.
 * 리컨실러와 같은 반영 Lua라 센티넬이 없으면(정산이 지운 시즌, 준비 전) 쓰지 않고, 다른 제외 집합에 아직 있으면 쓰지 않는다.
 * composite 계산 값은 SP가 정의와 함께 돌려준다 — 관리 API 프로세스는 랭킹 정의 캐시를 두지 않는다.
 * @param db 메인 DB 풀 또는 커넥션
 * @param redis Redis 클라이언트
 * @param rankingId 랭킹 ID
 * @param seasonNo 시즌 번호
 * @param memberId 멤버 ID
 * @returns 반영 결과 (-1 센티넬 없음, -2 제외 대상, 0 Redis가 더 새 값, 1 이상 반영, null 제출 없음). 실패는 예외
 * @author trisakion
 */
export async function reapplyMember(db: Pool | PoolConnection, redis: Redis, rankingId: number, seasonNo: number, memberId: string): Promise<number | null> {
    const { result, rows } = await callSp(db, 'SP_GET_RANKING_ENTRY_APPLY', [rankingId, seasonNo, memberId]);
    if (result !== SpResult.OK)
        throw new Error(`SP_GET_RANKING_ENTRY_APPLY result ${result}`);
    const r = rows[0];
    if (!r)
        return null;
    const rule: RankingRule = { updateRule: r.update_rule, sortOrder: r.sort_order, timeUnit: r.time_unit, timeBits: r.time_bits, maxSubmitPerMin: null };
    return reconcileScore(redis, seasonKeys(rankingId, seasonNo), {
        rankingId, seasonNo, memberId, composite: composite(rule, Number(r.score), r.achieved_at, r.start_at), version: r.version, ...applyMode(rule),
    });
}
