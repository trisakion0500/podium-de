/**
 * 확정(FINALIZING) 시간 측정 (01_DESIGN 7.6, D-68). 가순위가 매겨진 REVIEW 시즌을 직접 만들고 워커 finalize()와 같은
 * 순서로 SP를 불러 단계별 시간을 잰다. 로컬 개발 DB 전용이다. 운영 DB에 실행하지 않는다.
 *
 * 순서 (프로젝트 루트에서, 워커는 꺼 둔다 — 켜 두면 워커가 먼저 확정한다):
 *   npm run build
 *   node loadtest/finalize.mjs [members, 기본 100000] [chunk, 기본 5000]
 *
 * - 랭킹 933(보상 구간 4개, 절반이 보상 대상)과 934(구간 없음)를 같은 인원으로 확정해, 보상 판정(JSON_TABLE 상관
 *   서브쿼리)이 더하는 시간을 비교한다. 제재는 랭킹마다 100명.
 * - 시작 전과 끝난 뒤에 두 랭킹의 행·파티션을 지운다.
 * @author trisakion
 */
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const root = new URL('../dist/', import.meta.url).href;
const { createPool, callSp } = await import(root + 'core/db.js');
const IDS = { tiers: 933, none: 934 };
const members = Number(process.argv[2] ?? 100000);
const chunk = Number(process.argv[3] ?? 5000);
const M = createPool('MIGRATE'), A = createPool('APP');
const q = async (sql, p = []) => (await M.query(sql, p))[0];

/**
 * 두 랭킹의 흔적을 지운다.
 * @returns 없음
 */
async function clean() {
    const ids = Object.values(IDS);
    await q('DELETE FROM ranking_entry WHERE ranking_id IN (?)', [ids]);
    for (const id of ids) {
        const ps = (await q("SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry' AND PARTITION_DESCRIPTION LIKE ?", [`(${id},%`])).map((x) => '`' + x.n + '`');
        if (ps.length)
            await q(`ALTER TABLE ranking_entry DROP PARTITION ${ps.join(', ')}`);
        // 파티션 추가는 SP_PARTITION_ADD가 submit_key에도 한다
        const ks = (await q("SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_submit_key' AND PARTITION_DESCRIPTION LIKE ?", [`(${id},%`])).map((x) => '`' + x.n + '`');
        if (ks.length)
            await q(`ALTER TABLE ranking_submit_key DROP PARTITION ${ks.join(', ')}`);
    }
    for (const t of ['ranking_season', 'ranking_definition', 'ranking_reward_tier', 'ranking_season_top', 'ranking_exclusion'])
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ids]);
}

/**
 * 가순위 1..members인 REVIEW 시즌(검수 기간 지남)과 제재 100명을 만든다.
 * @param id 랭킹 ID
 * @param tiers 보상 구간을 넣을지
 * @returns 없음
 */
async function setup(id, tiers) {
    await q(`INSERT INTO ranking_definition (ranking_id, ranking_code, ranking_name, status, update_rule, sort_order, score_max, time_unit, time_bits,
              timezone, start_at, end_at, cycle_type, settle_delay, wait_period, review_period, history_retention, created_at, updated_at)
             VALUES (?, ?, 'finalize-load', 1, 1, 1, 8000000, 2, 25, 'UTC', UTC_TIMESTAMP(3) - INTERVAL 2 HOUR, NULL, 0, 60, 0, 60, 30, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`, [id, `FL${id}`]);
    await q(`INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, review_until, status)
             VALUES (?, 1, UTC_TIMESTAMP(3) - INTERVAL 2 HOUR, UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, UTC_TIMESTAMP(3) - INTERVAL 1 SECOND, 5)`, [id]);
    await callSp(A, 'SP_PARTITION_ADD', [id, 1]);
    for (let i = 0; i < members; i += 5000) {
        const rows = [];
        for (let j = i; j < Math.min(members, i + 5000); j++)
            rows.push([id, 1, `u${j}`, members - j, new Date(), 1, new Date(), j + 1]);
        await q('INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at, final_rank) VALUES ?', [rows]);
    }
    if (tiers)
        await q('INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code) VALUES ?',
            [[[id, 1, 1, 1, 1, 'R1'], [id, 2, 1, 2, 10, 'R10'], [id, 3, 2, 1, 10, 'P10'], [id, 4, 2, 11, 50, 'P50']]]);
    const banned = Array.from({ length: 100 }, (_, k) => [id, 1, `u${Math.floor((k + 0.5) * members / 100)}`, 'load', 'load', new Date()]);
    await q('INSERT INTO ranking_exclusion (ranking_id, season_no, member_id, reason, created_by, created_at) VALUES ?', [banned]);
}

/**
 * 워커 finalize()와 같은 순서로 확정하고 단계별 시간(ms)을 잰다.
 * @param id 랭킹 ID
 * @returns 단계별 시간과 결과
 */
async function finalize(id) {
    const t0 = Date.now();
    const start = (await callSp(A, 'SP_START_FINALIZING', [id, 1])).result;
    const t1 = Date.now();
    const ex = await callSp(A, 'SP_UPDATE_FINAL_EXCLUSION', [id, 1]);
    const t2 = Date.now();
    let base = 0, chunks = 0, slowest = 0;
    for (;;) {
        const c0 = Date.now();
        const n = (await callSp(A, 'SP_UPDATE_FINAL_RANK', [id, 1, base, chunk])).rows[0].ranked_count;
        slowest = Math.max(slowest, Date.now() - c0);
        if (n === 0)
            break;
        base += n;
        chunks++;
    }
    const t3 = Date.now();
    const delivering = (await callSp(A, 'SP_UPDATE_SEASON_DELIVERING', [id, 1])).result;
    const t4 = Date.now();
    const [{ pending }] = await q('SELECT COUNT(member_id) pending FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND reward_status = 1', [id]);
    return {
        result: [start, ex.result, delivering].join('/'), participants: ex.rows[0].participant_count, pending,
        startMs: t1 - t0, exclusionMs: t2 - t1, rankMs: t3 - t2, chunks, slowestChunkMs: slowest, deliveringMs: t4 - t3, totalMs: t4 - t0,
    };
}

try {
    await clean();
    await setup(IDS.tiers, true);
    await setup(IDS.none, false);
    const tiers = await finalize(IDS.tiers);
    const none = await finalize(IDS.none);
    console.log(JSON.stringify({ members, chunk, tiers, none, rewardCostMs: tiers.rankMs - none.rankMs }, null, 2));
} finally {
    await clean();
    await M.end();
    await A.end();
    (await import(root + 'core/logger.js')).shutdownLogger();
}
