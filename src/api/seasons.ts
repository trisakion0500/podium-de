import type { Pool } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { callSp } from '../core/db.js';
import { BusinessException } from '../core/errors.js';

/**
 * 현재 시즌 (SP_GET_CURRENT_SEASON)
 * @author trisakion
 */
export interface CurrentSeason {
    seasonNo: number;
    /** 시즌 시작 시각 (포함). composite 디코드 기준 */
    startAt: Date;
    /** 시즌 종료 시각 (미포함). 이 시각이 지나면 캐시를 버리고 다시 읽는다 */
    endAt: Date;
}

/** ranking_id → 현재 시즌 조회. 진행 중인 조회도 넣어 경계 시각에 몰린 요청이 SP를 한 번만 부르게 한다 */
const currentSeasons = new Map<number, Promise<CurrentSeason>>();

/**
 * 랭킹의 현재 시즌을 돌려준다. 처음 한 번 SP로 읽고 end_at까지 메모리에서 쓴다 — 시즌당 랭킹마다 DB 조회 1회다.
 * 현재 시즌이 없으면(1301) 캐시하지 않는다. 종료된 랭킹을 계속 조회하면 요청마다 SP를 부른다.
 * 앱 시계가 DB보다 빠르면 경계 직후 잠시 SP가 지난 시즌을 돌려주고 매 요청 다시 읽는다. DB 시계를 따라잡으면 멈춘다.
 * @param pool 메인 DB 풀
 * @param rankingId 랭킹 ID
 * @returns 현재 시즌. 없으면 BusinessException(1301)
 * @author trisakion
 * @modified 2026-10-09 trisakion rankings.ts에서 분리 (정의 캐시는 core/rankings.ts로, D-60)
 */
export async function getCurrentSeason(pool: Pool, rankingId: number): Promise<CurrentSeason> {
    const cached = currentSeasons.get(rankingId);
    if (cached) {
        // 진행 중인 조회가 실패하면 기다리던 요청도 같은 오류를 받는다.
        const season = await cached;
        if (season.endAt.getTime() > Date.now())
            return season;
        // 만료를 본 다른 요청이 이미 새 조회를 넣었으면 그것을 따른다.
        if (currentSeasons.get(rankingId) !== cached)
            return getCurrentSeason(pool, rankingId);
    }
    const load = callSp(pool, 'SP_GET_CURRENT_SEASON', [rankingId]).then(({ result, rows }) => {
        if (result === SpResult.CURRENT_SEASON_NOT_FOUND)
            throw new BusinessException(SpResult.CURRENT_SEASON_NOT_FOUND);
        if (result !== SpResult.OK)
            throw new Error(`SP_GET_CURRENT_SEASON result ${result}`);
        const row = rows[0];
        return { seasonNo: row.season_no as number, startAt: row.start_at as Date, endAt: row.end_at as Date };
    });
    currentSeasons.set(rankingId, load);
    try {
        return await load;
    } catch (err) {
        if (currentSeasons.get(rankingId) === load)
            currentSeasons.delete(rankingId);
        throw err;
    }
}
