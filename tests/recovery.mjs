/**
 * 3단계 자가 복구 회귀 테스트 (01_DESIGN 6장, D-60). Redis를 강제로 MySQL과 어긋나게 만들고 복구되는지 본다.
 * 4단계 시즌 스케줄러(01_DESIGN 3.3, 3.5)의 시즌 계산·선행 생성·상태 전이도 함께 본다.
 * 로컬 개발 DB·Redis 전용이다. 운영 DB에 실행하지 않는다.
 *
 * 순서 (프로젝트 루트에서):
 *   npm run build
 *   node tests/recovery.mjs [반복 수, 기본 3]
 *
 * - 워커와 API를 직접 띄우고 끝나면 끈다. API 포트는 TEST_PORT(기본 3199). 강제 종료라 하트비트가 남아,
 *   끝난 뒤 30초 동안은 migrate가 거부된다(05_TROUBLESHOOTING 1.1).
 * - 테스트 랭킹 940~951을 쓰고, 시작 전과 끝난 뒤에 모두 지운다(MySQL 행·파티션, job_state, 제출 이력, Redis 키, 테스트 API 키).
 * - API 키 원문은 메모리에만 두고 출력하지 않는다.
 * - 워커 로그는 logs/app.log.worker.t* 에 남는다. 로그 문구로 판정하는 항목이 있다.
 * - 규모는 시즌당 2,500명이다. 100만 명 규모 수치는 01_DESIGN 1.7의 실측값을 본다.
 * @author trisakion
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const root = new URL('../dist/', import.meta.url).href;
const { createPool, callSp } = await import(root + 'core/db.js');
const { config } = await import(root + 'core/config.js');
const { seasonKeys, createRedis, closeRedis, finishRebuild } = await import(root + 'core/redis.js');
const { composite, startRankingRefresh } = await import(root + 'core/rankings.js');
const { startRecovery } = await import(root + 'worker/recovery.js');
const { nextSeason } = await import(root + 'worker/scheduler.js');
const { hashApiKey } = await import(root + 'api/auth.js');
const { ApiScope } = await import(root + 'core/codes.js');
const { createClient } = await import('redis');

/** 복구 시나리오(BEST·SUM), 락 대기, API 경유(BEST·SUM), 스케줄러(FIXED, 단일 시즌, 종료), 정산(DESC, ASC 이어받기, 빈 시즌) */
const IDS = { best: 941, sum: 942, lock: 943, apiBest: 944, apiSum: 945, fixed: 946, single: 947, ended: 948, settleDesc: 949, settleAsc: 950, settleEmpty: 951, settleNoPart: 952, broken: 940 };
const ALL_IDS = Object.values(IDS);
const N = 2500;
const PORT = Number(process.env.TEST_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;

const M = createPool('MIGRATE');
const A = createPool('APP');
const LM = createPool('MIGRATE', 'LOG');
const R = createClient({ url: config.redis.url, password: config.redis.password });
await R.connect();

const results = [];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * 메인 DB에 SQL을 실행한다 (migrate 계정, 픽스처 전용).
 * @param sql SQL
 * @param params 바인딩 값
 * @returns 결과 행
 */
async function q(sql, params = []) {
    return (await M.query(sql, params))[0];
}

/**
 * 판정 하나를 기록하고 출력한다.
 * @param name 항목 이름
 * @param ok 통과 여부
 * @param detail 덧붙일 정보
 * @returns 없음
 */
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
}

/**
 * 테스트 랭킹의 흔적을 모두 지운다. 파티션까지 내려 테스트 전 상태로 돌린다.
 * @returns 없음
 */
async function clean() {
    for (const t of ['ranking_entry', 'ranking_submit_key']) {
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ALL_IDS]);
        for (const id of ALL_IDS) {
            const ps = (await q('SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_DESCRIPTION LIKE ?', [t, `(${id},%`]))
                .map((x) => '`' + x.n + '`');
            if (ps.length)
                await q(`ALTER TABLE ${t} DROP PARTITION ${ps.join(', ')}`);
        }
    }
    for (const t of ['ranking_season', 'ranking_definition', 'ranking_exclusion', 'job_state', 'ranking_entry_settling'])
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ALL_IDS]);
    // 정산 도중 끊긴 테스트가 남긴 정렬 인덱스·가상 컬럼 (작업 테이블이 비어 있을 때만 — 다른 시즌 정산 중이면 건드리지 않는다)
    if ((await q('SELECT COUNT(*) n FROM ranking_entry_settling'))[0].n === 0) {
        if ((await q("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order'")).length)
            await q('ALTER TABLE ranking_entry_settling DROP INDEX ix_settle_order');
        if ((await q("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND COLUMN_NAME = 'settle_slot'")).length)
            await q('ALTER TABLE ranking_entry_settling DROP COLUMN settle_slot');
    }
    await q("DELETE FROM api_credential WHERE key_name LIKE 'rtest-%'");
    await LM.query('DELETE FROM log_ranking_submit WHERE ranking_id IN (?)', [ALL_IDS]);
    for (const id of ALL_IDS)
        for await (const keys of R.scanIterator({ MATCH: `${config.redis.keyPrefix}rk:{${id}}*`, COUNT: 1000 }))
            if (keys.length)
                await R.unlink(keys);
}

/**
 * 테스트 랭킹 정의를 만든다. 시각은 DB 시각 기준 초 오프셋이다.
 * @param id 랭킹 ID
 * @param o 갱신 규칙(1:BEST, 2:SUM), 상태, 주기(codes.CycleType), FIXED 길이, 대기, 시작·종료 오프셋(초, 종료 null: 없음)
 * @returns 없음
 */
async function createDefinition(id, {
    updateRule = 1, status = 1, sortOrder = 1, timeUnit = 1, cycleType = 0, cycleValue = null, waitPeriod = 0, startSec = 0, endSec = null, settleDelay = 60, reviewPeriod = 60,
} = {}) {
    // score_max 8000: time_bits 40이면 score × 2^40이 2^53 안에 들어야 한다.
    await q(`INSERT INTO ranking_definition (ranking_id, ranking_code, ranking_name, status, update_rule, sort_order, score_max, time_unit, time_bits,
              timezone, start_at, end_at, cycle_type, cycle_value, settle_delay, wait_period, review_period, history_retention, max_delta, max_submit_per_min, created_at, updated_at)
             VALUES (?, ?, 'rtest', ?, ?, ?, 8000, ?, 40, 'UTC', NOW(3) + INTERVAL ? SECOND, IF(? IS NULL, NULL, NOW(3) + INTERVAL ? SECOND),
                     ?, ?, ?, ?, ?, 30, NULL, NULL, NOW(3), NOW(3))`,
    [id, `RT${id}`, status, updateRule, sortOrder, timeUnit, startSec, endSec, endSec ?? 0, cycleType, cycleValue, settleDelay, waitPeriod, reviewPeriod]);
}

/**
 * 시즌 행과 파티션을 직접 만든다 (스케줄러를 거치지 않는 픽스처). settle_at = end_at + 정의의 settle_delay.
 * @param id 랭킹 ID
 * @param no 시즌 번호
 * @param startSec 시작 오프셋(초, DB 시각 기준)
 * @param endSec 종료 오프셋(초)
 * @param status 상태 (codes.SeasonStatus)
 * @param partition 파티션도 만들지 (false: 이미 끝난 채 생성된 시즌 — 스케줄러는 파티션을 만들지 않는다)
 * @returns 없음
 */
async function createSeason(id, no, startSec, endSec, status, partition = true) {
    await q(`INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, status)
             SELECT ranking_id, ?, NOW(3) + INTERVAL ? SECOND, NOW(3) + INTERVAL ? SECOND, NOW(3) + INTERVAL ? SECOND + INTERVAL settle_delay SECOND, ?
               FROM ranking_definition WHERE ranking_id = ?`, [no, startSec, endSec, endSec, status, id]);
    if (partition)
        await callSp(A, 'SP_PARTITION_ADD', [id, no]);
}

/**
 * 테스트 랭킹과 진행 중인 시즌 1을 만든다. 센티넬은 만들지 않는다 — 워커 복구 잡이 만든다(D-60).
 * 반복 없는 영구 랭킹(cycle_type 0, end_at NULL)이라 워커 스케줄러가 시즌을 더 만들지 않는다.
 * @param id 랭킹 ID
 * @param updateRule 1:BEST, 2:SUM
 * @returns 없음
 */
async function createRanking(id, updateRule) {
    await createDefinition(id, { updateRule });
    await q(`INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, status)
             VALUES (?, 1, NOW(3) - INTERVAL 1 HOUR, NOW(3) + INTERVAL 3 HOUR, NOW(3) + INTERVAL 4 HOUR, 2)`, [id]);
    await callSp(A, 'SP_PARTITION_ADD', [id, 1]);
}

// ------------------------------------------------------------------------------------------------ 워커 프로세스

const workers = new Map();

/**
 * 워커를 띄운다. 주기 1초, 안전마진 5초로 줄여 빨리 수렴하게 한다.
 * @param id 인스턴스 ID (로그 파일 suffix)
 * @param env 추가 환경 변수
 * @returns 없음
 */
function startWorker(id, env = {}) {
    const p = spawn(process.execPath, ['dist/worker.js'], {
        stdio: 'ignore',
        env: { ...process.env, INSTANCE_ID: id, RECOVERY_INTERVAL_MS: '1000', RECOVERY_MARGIN_SEC: '5', ...env },
    });
    workers.set(id, p);
}

/**
 * 띄운 워커·API를 모두 끈다.
 * @returns 없음
 */
async function killAll() {
    for (const p of workers.values())
        p.kill();
    workers.clear();
    await sleep(500);
}

/**
 * 워커 로그에서 문구가 나온 횟수. 날짜 회전된 파일(app.log.worker.{id}.YYYYMMDD)까지 합친다 — 날짜가 바뀐 뒤 첫 기록에서
 * 현재 파일이 회전되면 현재 파일만 센 값은 줄어들어 "증가" 판정이 틀린다.
 * @param id 인스턴스 ID
 * @param text 찾을 문구
 * @returns 횟수
 */
function logCount(id, text) {
    const base = `app.log.worker.${id}`;
    if (!existsSync('logs'))
        return 0;
    return readdirSync('logs')
        .filter((f) => f === base || f.startsWith(`${base}.`))
        .reduce((n, f) => n + readFileSync(`logs/${f}`, 'utf8').split(text).length - 1, 0);
}

// ------------------------------------------------------------------------------------------------ 제출·대조

let seq = 0;

/**
 * MySQL에만 제출한다 — 커밋 직후 프로세스가 죽어 Redis 반영이 빠진 상황.
 * @param id 랭킹 ID
 * @param member 멤버 ID
 * @param value 입력 값
 * @returns 없음
 */
async function submit(id, member, value) {
    const { result } = await callSp(A, 'SP_SUBMIT_SCORE', [id, 1, member, value, `rt-${Date.now()}-${seq++}`]);
    if (result !== 0)
        throw new Error(`submit ${result}`);
}

/**
 * BEST·SUM 랭킹에 여러 건을 MySQL에만 제출한다.
 * @param count 건수
 * @param offset 멤버 번호 시작
 * @returns 없음
 */
async function submitMany(count, offset = 0) {
    const jobs = [];
    for (let i = 0; i < count; i++) {
        const m = `m${(i + offset) % N}`;
        jobs.push(submit(IDS.best, m, Math.floor(Math.random() * 8000)), submit(IDS.sum, m, 1 + Math.floor(Math.random() * 5)));
        if (jobs.length >= 40)
            await Promise.all(jobs.splice(0));
    }
    await Promise.all(jobs);
}

/**
 * MySQL 기준 기대값과 Redis 라이브 키를 비교한다 (제외 대상 빼고).
 * @param id 랭킹 ID
 * @returns 틀린 수, 기대 멤버 수, Redis 멤버 수, 센티넬 유무
 */
async function diff(id) {
    const [def] = await q('SELECT update_rule, sort_order, time_unit, time_bits FROM ranking_definition WHERE ranking_id = ?', [id]);
    const rule = { updateRule: def.update_rule, sortOrder: def.sort_order, timeUnit: def.time_unit, timeBits: def.time_bits };
    const [season] = await q('SELECT start_at FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [id]);
    const rows = await q(`SELECT member_id, score, achieved_at, version FROM ranking_entry e WHERE ranking_id = ? AND season_no = 1
        AND NOT EXISTS (SELECT 1 FROM ranking_exclusion x WHERE x.ranking_id = e.ranking_id AND x.season_no IN (1, 0) AND x.member_id = e.member_id)`, [id]);
    const keys = seasonKeys(id, 1);
    const z = new Map((await R.zRangeWithScores(keys.board, 0, -1)).map((x) => [x.value, x.score]));
    const ver = def.update_rule === 2 ? await R.hGetAll(keys.ver) : {};
    let bad = 0;
    for (const r of rows) {
        if (z.get(r.member_id) !== composite(rule, Number(r.score), r.achieved_at, season.start_at))
            bad++;
        if (def.update_rule === 2 && Number(ver[r.member_id]) !== r.version)
            bad++;
    }
    bad += Math.max(0, z.size - rows.length);
    return { bad, expected: rows.length, redis: z.size, ready: await R.exists(keys.ready) === 1 };
}

/**
 * BEST·SUM 두 랭킹이 MySQL과 일치할 때까지 기다린다.
 * @param label 항목 이름
 * @param timeoutMs 제한 시간
 * @returns 없음
 */
async function waitConsistent(label, timeoutMs = 30000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
        const b = await diff(IDS.best);
        const s = await diff(IDS.sum);
        last = { b, s };
        if (b.ready && s.ready && b.bad === 0 && s.bad === 0)
            return check(label, true, `(${Date.now() - start}ms, best ${b.redis}/${b.expected}, sum ${s.redis}/${s.expected})`);
        await sleep(300);
    }
    check(label, false, JSON.stringify(last));
}

// ------------------------------------------------------------------------------------------------ 1. 복구 시나리오

/**
 * 워커 복구 잡 시나리오 S0~S11. 각 시나리오는 이격을 강제로 만들고 MySQL과 다시 일치하는지 본다.
 * @returns 없음
 */
async function recoveryScenarios() {
    await createRanking(IDS.best, 1);
    await createRanking(IDS.sum, 2);
    await submitMany(N);
    const best = seasonKeys(IDS.best, 1);
    const sum = seasonKeys(IDS.sum, 1);

    startWorker('t1');
    await waitConsistent('S0 새 시즌(센티넬 없음) → 재구축으로 센티넬 생성, MySQL과 일치');
    const [st] = await q("SELECT synced_at FROM job_state WHERE job_name = 'reconciler' AND ranking_id = ?", [IDS.best]);
    check('S0 동기화 시각 기록', !!st?.synced_at);

    await submitMany(600, 7);
    await waitConsistent('S1 Redis 반영이 빠진 커밋 600건×2 → L2가 따라잡음');

    // version HASH만 남고 ZSET 멤버가 빠진 경우: 변경분 스캔 대상이 되도록 같은 멤버를 다시 제출
    await R.zRem(sum.board, ['m1', 'm2']);
    await submit(IDS.sum, 'm1', 1);
    await submit(IDS.sum, 'm2', 1);
    await waitConsistent('S1b SUM ZSET 멤버 유실 + 변경분 → L2 복원');

    await R.del([best.ready, best.board, sum.ready, sum.board, sum.ver]);
    await waitConsistent('S2 Redis 키 유실 → 재구축 결과가 MySQL과 일치');

    await q("INSERT INTO ranking_exclusion (ranking_id, season_no, member_id, reason, created_by, created_at) VALUES (?, 1, 'm10', 'test', 'rt', NOW(3)), (?, 0, 'm11', 'test', 'rt', NOW(3))", [IDS.best, IDS.best]);
    await submit(IDS.best, 'm10', 7999);
    await R.del(best.ready);
    await waitConsistent('S3 제외 대상(시즌·전 시즌) 재구축·L2에서 제외');
    check('S3 m10·m11 순위표에 없음', await R.zScore(best.board, 'm10') === null && await R.zScore(best.board, 'm11') === null);

    const writes = submitMany(1500, 13);
    await sleep(100);
    await R.del([best.ready, sum.ready]);
    await writes;
    await waitConsistent('S4 재구축 중 제출 1500건×2 → 따라잡기 + 다음 L2로 일치');

    startWorker('t2');
    await sleep(2500);
    const rebuilt = () => logCount('t1', `rebuilt ranking=${IDS.best} `) + logCount('t2', `rebuilt ranking=${IDS.best} `);
    const before = rebuilt();
    await R.del(best.ready);
    await waitConsistent('S5 워커 2대 — 재구축');
    await sleep(2500);
    check('S5 재구축은 한 워커에서 1회만', rebuilt() - before === 1, `(${rebuilt() - before}회)`);

    workers.get('t1').kill();
    workers.delete('t1');
    await sleep(500);
    const t2Before = logCount('t2', `rebuilt ranking=${IDS.best} `);
    await R.del(best.ready);
    await waitConsistent('S5b 락 보유 워커 강제 종료 → 남은 워커가 이어받음');
    check('S5b t2가 재구축', logCount('t2', `rebuilt ranking=${IDS.best} `) > t2Before);
    await killAll();

    // S7: RDB 스냅샷 복원 흉내 — 스냅샷 뒤 반영분을 잃은 채 센티넬이 돌아와도 센티넬 값부터 다시 읽어 메운다
    const live = [best.board, best.ver, best.ready, sum.board, sum.ver, sum.ready];
    startWorker('t3');
    await waitConsistent('S7 준비');
    await killAll();
    for (const k of live)
        await R.sendCommand(['COPY', k, `${k}:snap`, 'REPLACE']);
    startWorker('t3');
    await submitMany(600, 21);
    await waitConsistent('S7 스냅샷 이후 커밋 반영');
    await sleep(8000); // 동기화 시각 − 안전마진(5초)이 위 커밋 시각을 지나가게 한다
    await killAll();
    for (const k of live)
        if (await R.sendCommand(['COPY', `${k}:snap`, k, 'REPLACE']) === 0)
            await R.unlink(k);
    const restoredBefore = logCount('t3', 'reconcile from redis sentinel');
    startWorker('t3');
    await waitConsistent('S7 RDB 복원 흉내 → 센티넬 값부터 다시 읽어 일치', 15000);
    check('S7 복원 감지 경고 로그', logCount('t3', 'reconcile from redis sentinel') > restoredBefore);
    await killAll();

    // S9: 보조 점검 불일치 → 센티넬을 지우지 않고 L2 전체 스캔으로 채움 (변경분 창 밖의 오래된 멤버 유실)
    await sleep(6000); // 남은 멤버들의 updated_at이 동기화 시각 − 안전마진(5초)보다 오래되게 한다
    await R.zRem(best.board, ['m100', 'm200', 'm300']);
    await R.zRem(sum.board, ['m100', 'm200', 'm300']);
    await q("DELETE FROM job_state WHERE job_name = 'recovery_audit' AND ranking_id IN (?)", [[IDS.best, IDS.sum]]);
    const rb9 = logCount('t3', 'rebuilt ranking=');
    const full9 = logCount('t3', '— full reconcile');
    startWorker('t3');
    await waitConsistent('S9 점검 불일치 → L2 전체 스캔으로 일치', 15000);
    check('S9 재구축 없이 (full reconcile 로그, rebuilt 증가 없음)', logCount('t3', '— full reconcile') > full9 && logCount('t3', 'rebuilt ranking=') === rb9);
    await killAll();

    // S10: 시작 60초 전 시즌은 미리 센티넬을 세우고, 그보다 먼 시즌은 아직 두지 않는다. 미리 연 시즌은 점검 시계도 시작된다
    for (const [no, sec] of [[2, 30], [3, 120]]) {
        await q('INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, status) VALUES (?, ?, NOW(3) + INTERVAL ? SECOND, NOW(3) + INTERVAL 5 HOUR, NOW(3) + INTERVAL 6 HOUR, 1)', [IDS.best, no, sec]);
        await callSp(A, 'SP_PARTITION_ADD', [IDS.best, no]);
    }
    startWorker('t3');
    let s2 = false;
    for (let i = 0; i < 30 && !s2; i++) {
        await sleep(300);
        s2 = await R.exists(seasonKeys(IDS.best, 2).ready) === 1;
    }
    await sleep(1500);
    const s3 = await R.exists(seasonKeys(IDS.best, 3).ready) === 1;
    const [a2] = await q("SELECT last_run_at FROM job_state WHERE job_name = 'recovery_audit' AND ranking_id = ? AND season_no = 2", [IDS.best]);
    const early = await callSp(A, 'SP_SUBMIT_SCORE', [IDS.best, 2, 'm1', 100, `rt-early-${Date.now()}`]);
    check('S10 시작 30초 전 시즌은 센티넬 준비, 120초 전 시즌은 아직', s2 && !s3, `(s2 ${s2}, s3 ${s3})`);
    check('S10 미리 연 시즌은 점검 시계 시작, 시작 전 제출은 1103', !!a2?.last_run_at && early.result === 1103 && await R.zCard(seasonKeys(IDS.best, 2).board) === 0);
    await killAll();

    // S11: 실제 재구축 도중 임시 키 유실(Redis 재시작 흉내) → 교체 거부, 다음 주기 재구축으로 일치. 청크를 작게 해 재구축을 늘린다
    const aborted = logCount('t4', 'rebuild aborted: temp keys lost members');
    startWorker('t4', { RECOVERY_CHUNK: '20' });
    await waitConsistent('S11 준비');
    let hit = false;
    for (let attempt = 0; attempt < 5 && !hit; attempt++) {
        await R.del(sum.ready);
        const until = Date.now() + 5000;
        while (Date.now() < until) {
            if (await R.zCard(sum.rebuild) >= 200) {
                await R.unlink([sum.rebuild, sum.rebuildVer]);
                hit = true;
                break;
            }
        }
        await waitConsistent(`S11 시도 ${attempt + 1} 복구 일치`, 15000);
    }
    check('S11 재구축 도중 임시 키 유실을 만듦', hit);
    check('S11 교체 거부 로그(rebuild aborted)', logCount('t4', 'rebuild aborted: temp keys lost members') > aborted);
    await killAll();

    // S8: 교체 Lua 단독 — 임시 ZSET이 적재 수보다 작으면 교체하지 않는다
    const r8 = createRedis();
    await sleep(300);
    const k = seasonKeys(IDS.best, 99);
    await R.zAdd(k.rebuild, [1, 2, 3].map((i) => ({ score: i, value: `x${i}` })));
    const refused = await finishRebuild(r8, k, new Date(), 5);
    const untouched = await R.exists(k.ready) === 0 && await R.exists(k.rebuild) === 1;
    const swapped = await finishRebuild(r8, k, new Date(1234), 3);
    check('S8 임시 키 유실 시 교체 거부, 정상이면 교체', !refused && untouched && swapped && await R.zCard(k.board) === 3 && await R.get(k.ready) === '1234');
    await closeRedis(r8);

    // S6: 정상 종료 — 재구축 도중 stop()이 청크 경계에서 끝나기를 기다리고, 그 뒤 풀을 닫아도 오류가 없다
    const pool = createPool('APP');
    const redis = createRedis();
    await sleep(300);
    const stopRefresh = await startRankingRefresh(pool);
    await R.del([best.ready, sum.ready]);
    const stop = startRecovery(pool, redis);
    await sleep(30);
    const t = Date.now();
    let err = null;
    try {
        await stop();
        stopRefresh();
        await closeRedis(redis);
        await pool.end();
    } catch (e) {
        err = e;
    }
    check('S6 정상 종료 (stop 대기 후 풀 종료 오류 없음)', err === null, `(${Date.now() - t}ms${err ? ' ' + err.message : ''})`);
}

// ------------------------------------------------------------------------------------------------ 2. 락 대기 제한

/**
 * SP_SUBMIT_SCORE의 락 대기 5초 제한과 세션 변수 복원 (리컨실러 안전마진 보장, 01_DESIGN 6.2).
 * @returns 없음
 */
async function lockWait() {
    await createRanking(IDS.lock, 2);
    const conn = await A.getConnection();
    try {
        await conn.query('SET SESSION innodb_lock_wait_timeout = 37');
        const ok = await callSp(conn, 'SP_SUBMIT_SCORE', [IDS.lock, 1, 'u1', 10, `lw-ok-${Date.now()}`]);
        const [[v1]] = await conn.query('SELECT @@SESSION.innodb_lock_wait_timeout AS v');
        check('L1 성공 경로 후 세션 값 복원', ok.result === 0 && v1.v === 37, `(${v1.v})`);

        // 다른 세션이 entry 행을 잠근 채 버틴다
        const holder = await M.getConnection();
        await holder.query('START TRANSACTION');
        await holder.query("SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = 'u1' FOR UPDATE", [IDS.lock]);
        const t = Date.now();
        let errNo = null;
        try {
            await callSp(conn, 'SP_SUBMIT_SCORE', [IDS.lock, 1, 'u1', 10, `lw-wait-${Date.now()}`]);
        } catch (e) {
            errNo = e.errorNo ?? e.message;
        }
        const waited = Date.now() - t;
        await holder.query('ROLLBACK');
        holder.release();
        const [[v2]] = await conn.query('SELECT @@SESSION.innodb_lock_wait_timeout AS v');
        check('L2 락 대기 약 5초 후 1205(50001)', String(errNo).includes('1205') && waited >= 4800 && waited < 7000, `(${waited}ms)`);
        check('L3 실패 경로 후 세션 값 복원', v2.v === 37, `(${v2.v})`);
    } finally {
        conn.release();
    }
}

// ------------------------------------------------------------------------------------------------ 3. API 경유

/**
 * API·워커를 띄운 상태에서 제출·조회 회귀와 강제 이격 복구를 API 응답으로 확인한다.
 * @returns 없음
 */
async function apiScenarios() {
    await createRanking(IDS.apiBest, 1);
    await createRanking(IDS.apiSum, 2);
    const mk = async (name, scopes) => {
        const key = randomBytes(32).toString('base64url');
        await callSp(M, 'SP_INSERT_API_CREDENTIAL', [name, hashApiKey(key), scopes]);
        return key;
    };
    const writeKey = await mk('rtest-write', ApiScope.WRITE);
    const readKey = await mk('rtest-read', ApiScope.READ);
    startWorker('t5');
    workers.set('api', spawn(process.execPath, ['dist/api.js'], { stdio: 'ignore', env: { ...process.env, INSTANCE_ID: 'tapi', API_PORT: String(PORT) } }));

    const post = async (id, body) => (await fetch(`${BASE}/v1/rankings/${id}/scores`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': writeKey }, body: JSON.stringify(body),
    })).json();
    const get = async (path) => (await fetch(BASE + path, { headers: { 'x-api-key': readKey } })).json();
    const waitFor = async (fn, ms = 15000) => {
        const t = Date.now();
        while (Date.now() - t < ms) {
            try {
                if (await fn())
                    return Date.now() - t;
            } catch {
                // API 기동 전에는 연결이 거부된다.
            }
            await sleep(200);
        }
        return -1;
    };
    // 기동과 센티넬 준비(워커 첫 주기)를 기다린다.
    const up = await waitFor(async () => (await get(`/v1/rankings/${IDS.apiSum}/top?size=1`)).result === 0 && (await get(`/v1/rankings/${IDS.apiBest}/top?size=1`)).result === 0, 30000);
    check('A0 API·워커 기동, 순위표 준비', up >= 0, `(${up}ms)`);

    const tag = `api-${Date.now()}`;
    const a = await post(IDS.apiSum, { memberId: tag, value: 5, seasonNo: 1, requestId: `${tag}-1` });
    const b = await post(IDS.apiSum, { memberId: tag, value: 3, seasonNo: 1, requestId: `${tag}-2` });
    const replay = await post(IDS.apiSum, { memberId: tag, value: 3, seasonNo: 1, requestId: `${tag}-2` });
    const me = await get(`/v1/rankings/${IDS.apiSum}/members/${tag}`);
    check('A1 SUM 누적·재전송', a.result === 0 && b.data?.score === 8 && replay.data?.replayed === true && me.data?.score === 8, JSON.stringify(me.data));
    await post(IDS.apiBest, { memberId: tag, value: 7000, seasonNo: 1, requestId: `${tag}-3` });
    await post(IDS.apiBest, { memberId: tag, value: 100, seasonNo: 1, requestId: `${tag}-4` });
    const top = await get(`/v1/rankings/${IDS.apiBest}/top?size=5&memberId=${tag}`);
    check('A2 BEST 최고값 유지·조회', top.result === 0 && top.data?.me?.score === 7000, JSON.stringify(top.data?.me));

    // D1: 반영 유실(API 반영 실패 흉내) — 멤버를 ZSET에서 지움
    await R.zRem(seasonKeys(IDS.apiBest, 1).board, tag);
    const d1 = await waitFor(async () => (await get(`/v1/rankings/${IDS.apiBest}/top?size=1&memberId=${tag}`)).data?.me?.score === 7000);
    check('A3 BEST 반영 유실 → L2 복구', d1 >= 0, `(${d1}ms)`);

    // D2: 틀린 값 — SUM 점수와 version을 망가뜨림
    await R.zAdd(seasonKeys(IDS.apiSum, 1).board, { score: 2 ** 40, value: tag });
    await R.hSet(seasonKeys(IDS.apiSum, 1).ver, tag, '0');
    const d2 = await waitFor(async () => (await get(`/v1/rankings/${IDS.apiSum}/members/${tag}`)).data?.score === 8);
    check('A4 SUM 틀린 값·version → L2 복구', d2 >= 0, `(${d2}ms)`);

    // D3: 시즌 키 전체 유실 — 조회는 2007, 재구축 뒤 원래 값
    const k = seasonKeys(IDS.apiSum, 1);
    await R.del([k.ready, k.board, k.ver]);
    const during = await get(`/v1/rankings/${IDS.apiSum}/members/${tag}`);
    const d3 = await waitFor(async () => (await get(`/v1/rankings/${IDS.apiSum}/members/${tag}`)).data?.score === 8);
    check('A5 키 유실 → 2007 → 재구축 복구', during.result === 2007 && d3 >= 0, `(유실 직후 ${during.result}, ${d3}ms)`);
}

// ------------------------------------------------------------------------------------------------ 4. 시즌 스케줄러

/**
 * 시즌 계산(nextSeason) 단독 검사. 달력 경계는 timezone 벽시계 기준이다.
 * @returns 없음
 */
function seasonMath() {
    const iso = (s) => s && `${s.seasonNo} ${s.startAt.toISOString()}~${s.endAt.toISOString()}`;
    const chain = (cycle, n) => {
        const out = [];
        let last = null;
        for (let i = 0; i < n; i++) {
            last = nextSeason(cycle, last);
            out.push(iso(last));
        }
        return out;
    };
    const base = { timezone: 'UTC', endAt: null, cycleValue: null, waitPeriod: 0 };
    const at = (s) => new Date(s);

    const daily = chain({ ...base, timezone: 'Asia/Seoul', cycleType: 1, startAt: at('2026-10-10T15:00:00Z') }, 2);
    check('C1 DAILY Asia/Seoul 자정 경계', daily.join() === '1 2026-10-10T15:00:00.000Z~2026-10-11T15:00:00.000Z,2 2026-10-11T15:00:00.000Z~2026-10-12T15:00:00.000Z', daily.join());

    // 2026-11-01 02:00 EDT → 01:00 EST. 자정은 그대로 자정이라 그날 시즌은 25시간이다.
    const dst = chain({ ...base, timezone: 'America/New_York', cycleType: 1, startAt: at('2026-10-31T04:00:00Z') }, 2);
    check('C2 DAILY DST 전환일도 벽시계 자정', dst[1] === '2 2026-11-01T04:00:00.000Z~2026-11-02T05:00:00.000Z', dst.join());

    const weekly = chain({ ...base, timezone: 'Asia/Seoul', cycleType: 2, startAt: at('2026-10-07T15:00:00Z') }, 1);
    check('C3 WEEKLY 시작 요일부터 7일', weekly[0] === '1 2026-10-07T15:00:00.000Z~2026-10-14T15:00:00.000Z', weekly.join());

    const monthly = chain({ ...base, cycleType: 3, startAt: at('2026-01-28T00:00:00Z') }, 3);
    check('C4 MONTHLY 28일 시작은 매달 28일', monthly.join() === '1 2026-01-28T00:00:00.000Z~2026-02-28T00:00:00.000Z,2 2026-02-28T00:00:00.000Z~2026-03-28T00:00:00.000Z,3 2026-03-28T00:00:00.000Z~2026-04-28T00:00:00.000Z', monthly.join());

    // C8: MONTHLY 29일 이후 시작이 다음 시즌으로 이어지면 거부 (D-67). 마지막 시즌(랭킹 end_at에서 잘림)이면 허용
    const rejects = (cycle, last = null) => {
        try {
            nextSeason(cycle, last);
            return false;
        } catch (e) {
            return /after day 28/.test(e.message);
        }
    };
    const m31 = { ...base, cycleType: 3, startAt: at('2026-01-31T00:00:00Z') };
    const single = chain({ ...m31, endAt: at('2026-02-15T00:00:00Z') }, 2);
    const kstDay29 = { ...base, cycleType: 3, timezone: 'Asia/Seoul', startAt: at('2026-01-28T15:00:00Z') };
    const waitShift = { ...base, cycleType: 3, waitPeriod: 4 * 86400, startAt: at('2026-03-25T00:00:00Z') };
    const s1 = nextSeason(waitShift, null);
    check('C8 MONTHLY 29일 이후 시작 거부(이어지는 시즌, timezone 날짜, wait_period로 밀린 시즌), 단일 시즌은 허용',
        rejects(m31) && rejects(kstDay29) && rejects(waitShift, s1) && single[0] === '1 2026-01-31T00:00:00.000Z~2026-02-15T00:00:00.000Z' && single[1] === null,
        `(31일 ${rejects(m31)}, KST 29일 ${rejects(kstDay29)}, wait ${rejects(waitShift, s1)}, 단일 ${single.join()})`);

    const t = '2026-10-10T00:00:';
    const wait = chain({ ...base, cycleType: 4, cycleValue: 60, waitPeriod: 30, startAt: at(`${t}00Z`) }, 2);
    check('C5 FIXED + wait_period', wait[1] === '2 2026-10-10T00:01:30.000Z~2026-10-10T00:02:30.000Z', wait.join());

    const clipped = chain({ ...base, cycleType: 4, cycleValue: 100, startAt: at(`${t}00Z`), endAt: at('2026-10-10T00:02:30Z') }, 3);
    check('C6 랭킹 종료에서 자르고 이후 시즌 없음', clipped[1] === '2 2026-10-10T00:01:40.000Z~2026-10-10T00:02:30.000Z' && clipped[2] === null, clipped.join());

    const permanent = chain({ ...base, cycleType: 0, startAt: at(`${t}00Z`) }, 2);
    check('C7 영구 랭킹은 시즌 1개(9999-12-31까지)', permanent[0] === '1 2026-10-10T00:00:00.000Z~9999-12-31T00:00:00.000Z' && permanent[1] === null, permanent.join());
}

/**
 * 한 랭킹의 시즌 행과 두 파티션 존재 여부.
 * @param id 랭킹 ID
 * @returns 시즌 번호 순 { no, status, start, end, parts }
 */
async function seasonsOf(id) {
    const rows = await q('SELECT season_no, status, start_at, end_at FROM ranking_season WHERE ranking_id = ? ORDER BY season_no', [id]);
    const parts = await q("SELECT TABLE_NAME t, PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('ranking_entry', 'ranking_submit_key') AND PARTITION_DESCRIPTION LIKE ?", [`(${id},%`]);
    return rows.map((r) => ({
        no: r.season_no, status: r.status, start: r.start_at.getTime(), end: r.end_at.getTime(),
        parts: parts.filter((p) => p.n === `p_r${id}_s${r.season_no}`).length,
    }));
}

/**
 * 조건이 맞을 때까지 기다린다.
 * @param fn 조건
 * @param ms 제한 시간
 * @returns 걸린 ms (-1: 시간 초과)
 */
async function until(fn, ms = 15000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
        if (await fn())
            return Date.now() - t;
        await sleep(200);
    }
    return -1;
}

/**
 * 워커 스케줄러 시나리오: 선행 생성(현재 + 다음 2개), 지난 시즌 이어 만들기, 상태 전이, 빠진 파티션 채우기,
 * 단일 시즌·종료 랭킹, 새로 열릴 시즌의 센티넬 준비(D-60).
 * @returns 없음
 */
async function schedulerScenarios() {
    seasonMath();
    // FIXED 20초 주기, 30초 전에 시작 → 시즌 1은 이미 끝, 2 진행 중(10초 남음), 3·4 예정
    await createDefinition(IDS.fixed, { cycleType: 4, cycleValue: 20, startSec: -30 });
    await createDefinition(IDS.single, { cycleType: 0, startSec: -60, endSec: 3600 });
    await createDefinition(IDS.ended, { status: 3, cycleType: 4, cycleValue: 20, startSec: -30 });
    // 잘못된 정의(FIXED인데 cycle_value 없음). 이 랭킹만 건너뛰고 다른 랭킹(946, 947)은 시즌이 만들어져야 한다. 랭킹 ID가 가장 작아 먼저 처리된다
    await createDefinition(IDS.broken, { cycleType: 4, cycleValue: null, startSec: -30 });
    const brokenLog = () => logCount('t6', `season plan skipped ranking=${IDS.broken}`);
    const brokenBefore = brokenLog();
    startWorker('t6', { SCHEDULER_INTERVAL_MS: '500' });

    let s = [];
    const ok1 = await until(async () => {
        s = await seasonsOf(IDS.fixed);
        return s.length === 4 && s.map((x) => x.status).join() === '3,2,1,1';
    });
    const contiguous = s.every((x, i) => i === 0 || x.start === s[i - 1].end) && s.every((x) => x.end - x.start === 20000);
    check('G1 지난 시즌부터 이어 4개 생성, 상태 CLOSED·OPEN·SCHEDULED×2', ok1 >= 0 && contiguous, JSON.stringify(s.map((x) => [x.no, x.status])));
    check('G2 이미 끝난 채 생성된 시즌 1은 파티션 없음, 나머지는 두 파티션', s.length === 4 && s[0].parts === 0 && s.slice(1).every((x) => x.parts === 2),
        JSON.stringify(s.map((x) => [x.no, x.parts])));

    const cur = await callSp(A, 'SP_GET_CURRENT_SEASON', [IDS.fixed]);
    const no = cur.rows[0]?.season_no;
    const sub = await callSp(A, 'SP_SUBMIT_SCORE', [IDS.fixed, no, 'm1', 100, `rt-sched-${Date.now()}`]);
    check('G3 현재 시즌에 제출 성공', cur.result === 0 && sub.result === 0, `(season ${no}, result ${sub.result})`);
    const ready = await until(async () => await R.exists(seasonKeys(IDS.fixed, no + 1).ready) === 1, 10000);
    check('G4 다음 시즌 센티넬이 시작 전에 준비 (복구 잡, D-60)', ready >= 0);

    const ok5 = await until(async () => {
        s = await seasonsOf(IDS.fixed);
        // 스케줄러는 행을 넣은 뒤 파티션을 더한다. 파티션까지 생긴 뒤에 넘어가야 G6의 DROP이 경합하지 않는다
        return s.length === 5 && s[1].status === 3 && s.slice(1).every((x) => x.parts === 2);
    }, 25000);
    check('G5 시간이 지나면 다음 시즌 생성·전 시즌 CLOSED', ok5 >= 0, JSON.stringify(s.map((x) => [x.no, x.status])));

    // 시즌 INSERT 뒤 파티션 DDL 전에 워커가 죽은 경우를 흉내 낸다 (빈 예정 시즌의 submit_key 파티션 삭제)
    const last = s[s.length - 1].no;
    await q(`ALTER TABLE ranking_submit_key DROP PARTITION p_r${IDS.fixed}_s${last}`);
    const ok6 = await until(async () => (await seasonsOf(IDS.fixed)).find((x) => x.no === last)?.parts === 2, 10000);
    check('G6 빠진 파티션 채움', ok6 >= 0);

    const single = await seasonsOf(IDS.single);
    const [def] = await q('SELECT end_at FROM ranking_definition WHERE ranking_id = ?', [IDS.single]);
    check('G7 단일 시즌 랭킹은 1개, 종료는 랭킹 end_at', single.length === 1 && single[0].status === 2 && single[0].end === def.end_at.getTime(), JSON.stringify(single));
    check('G8 ENDED 랭킹은 시즌을 만들지 않음', (await seasonsOf(IDS.ended)).length === 0);
    check('G10 잘못된 정의(FIXED cycle_value 없음)는 시즌 없이 건너뛰고 오류 로그 1회, 다른 랭킹은 정상',
        (await seasonsOf(IDS.broken)).length === 0 && brokenLog() - brokenBefore === 1 && s.length >= 4,
        `(로그 ${brokenLog() - brokenBefore}회)`);

    // 풀을 거치지 않는 클라이언트(Workbench, 운영 도구)는 세션 time_zone이 서버 기본값이다. 그래도 SP는 UTC로 기록해야 한다 (D-66)
    const kst = await A.getConnection();
    try {
        await kst.query("SET time_zone = '+09:00'");
        await callSp(kst, 'SP_UPSERT_JOB_STATE', ['tz_test', IDS.fixed, 0, null]);
        const [cur9] = await callSp(kst, 'SP_GET_CURRENT_SEASON', [IDS.fixed]).then((r) => r.rows);
        const [{ skew }] = await q("SELECT TIMESTAMPDIFF(SECOND, last_run_at, UTC_TIMESTAMP(3)) skew FROM job_state WHERE job_name = 'tz_test' AND ranking_id = ?", [IDS.fixed]);
        const [utcCur] = (await callSp(A, 'SP_GET_CURRENT_SEASON', [IDS.fixed])).rows;
        check('G9 세션 +09:00에서도 SP는 UTC (기록 시각, 현재 시즌)', Math.abs(skew) < 5 && cur9?.season_no === utcCur?.season_no, `(skew ${skew}s, season ${cur9?.season_no}/${utcCur?.season_no})`);
    } finally {
        // 세션 시간대를 바꾼 커넥션은 풀에 돌려주지 않는다
        kst.destroy();
    }
}

// ------------------------------------------------------------------------------------------------ 5. 정산 (SETTLING → REVIEW)

/**
 * 시즌의 member_id를 final_rank 순으로 읽는다.
 * @param id 랭킹 ID
 * @returns { ranks: final_rank 목록, members: member_id 목록 }
 */
async function finalOrder(id) {
    const rows = await q('SELECT member_id, final_rank FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 ORDER BY final_rank', [id]);
    return { ranks: rows.map((r) => r.final_rank), members: rows.map((r) => r.member_id) };
}

/**
 * 작업 테이블이 비어 있고 정렬 인덱스·가상 컬럼이 남지 않았는지 (EXCHANGE로 되돌린 뒤 운영 테이블과 같은 구조).
 * @returns 깨끗하면 true
 */
async function settlingClean() {
    const [{ n }] = await q('SELECT COUNT(*) n FROM ranking_entry_settling');
    const col = await q("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND COLUMN_NAME = 'settle_slot'");
    const idx = await q("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order'");
    return n === 0 && col.length === 0 && idx.length === 0;
}

/**
 * 정산 잡 시나리오 (01_DESIGN 7.1, 7.3, 8.6).
 * - DESC·SEC 단위·동점 다수: 최종 가순위가 마감 시점 Redis 순서와 같다 (D-57). Redis 시즌 키는 지워진다.
 * - ASC: 손으로 꺼내고 한 청크만 매긴 상태(워커가 도중에 죽은 상태)에서 워커가 이어받아 끝낸다.
 * - 빈 시즌: 바로 REVIEW. 시작 조건 1010(미종료 트랜잭션), 1011(동기화 시각 미달)은 SP를 직접 불러 본다.
 * @returns 없음
 */
async function settlementScenarios() {
    const M2 = 500;
    // DESC, time_unit SEC: 같은 초 안의 동점은 member_id DESC — Redis와 같아야 한다. 마감 20초 뒤, settle_delay 1초
    await createDefinition(IDS.settleDesc, { timeUnit: 2, settleDelay: 1, reviewPeriod: 3600 });
    await createSeason(IDS.settleDesc, 1, -30, 20, 2);
    // ASC, 이미 끝난 시즌. 제출 SP는 지난 시즌을 거부하므로 행을 직접 넣는다
    await createDefinition(IDS.settleAsc, { sortOrder: 2, settleDelay: 1, reviewPeriod: 3600 });
    await createSeason(IDS.settleAsc, 1, -60, -30, 3);
    // 빈 시즌: 곧 끝난다
    await createDefinition(IDS.settleEmpty, { settleDelay: 1, reviewPeriod: 3600 });
    await createSeason(IDS.settleEmpty, 1, -30, 3, 2);
    // 이미 끝난 채 생성되어 파티션이 없는 시즌 (워커가 오래 멈췄다 돌아와 이어 만든 경우)
    await createDefinition(IDS.settleNoPart, { settleDelay: 1, reviewPeriod: 3600 });
    await createSeason(IDS.settleNoPart, 1, -60, -30, 3, false);

    // 1010: 마감 전에 시작한 트랜잭션이 열려 있으면 정산을 시작하지 않는다
    const trx = await M.getConnection();
    await trx.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    await trx.query('SELECT 1 FROM ranking_season LIMIT 1');

    const jobs = [];
    for (let i = 0; i < N; i++) {
        jobs.push(submit(IDS.settleDesc, `m${i}`, Math.floor(Math.random() * 30)));
        if (jobs.length >= 40)
            await Promise.all(jobs.splice(0));
    }
    await Promise.all(jobs);

    const [asc] = await q('SELECT start_at FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleAsc]);
    const ascRows = [];
    for (let i = 0; i < M2; i++)
        ascRows.push([IDS.settleAsc, 1, `a${i}`, Math.floor(Math.random() * 20), new Date(asc.start_at.getTime() + Math.floor(Math.random() * 5) * 1000), 1, new Date()]);
    await q('INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at) VALUES ?', [ascRows]);
    const ascExpected = [...ascRows].sort((x, y) => x[3] - y[3] || x[4] - y[4] || (x[2] < y[2] ? -1 : 1)).map((x) => x[2]);

    // 빈 시즌이 끝나 settle_at이 지나도록 기다린 뒤 CLOSED로 두고 직접 부른다 (아직 워커 없음)
    await sleep(5000);
    await q('UPDATE ranking_season SET status = 3 WHERE ranking_id = ? AND season_no = 1', [IDS.settleEmpty]);
    const r1010 = await callSp(A, 'SP_START_SETTLING', [IDS.settleEmpty, 1, 0]);
    await trx.query('COMMIT');
    trx.release();
    await sleep(300); // INNODB_TRX는 InnoDB가 최대 0.1초 캐시한다 — 커밋 직후에는 끝난 트랜잭션이 아직 보인다
    const r1011 = await callSp(A, 'SP_START_SETTLING', [IDS.settleEmpty, 1, 0]);
    check('T1 시작 조건: 마감 전 트랜잭션 열림 1010, 동기화 시각 없음 1011', r1010.result === 1010 && r1011.result === 1011, `(${r1010.result}, ${r1011.result})`);

    // ASC: 워커가 꺼내고 한 청크만 매긴 뒤 죽은 상태를 만든다
    await q('UPDATE ranking_season SET status = 4 WHERE ranking_id = ? AND season_no = 1', [IDS.settleAsc]);
    const out = await callSp(A, 'SP_SETTLING_EXCHANGE', [IDS.settleAsc, 1]);
    const part = await callSp(A, 'SP_UPDATE_SETTLING_RANK', [IDS.settleAsc, 1, 100]);
    check('T2 꺼내기(OUT) 후 한 청크 100행', out.rows[0]?.settling_state === 1 && part.rows[0]?.ranked_count === 100);

    startWorker('t7', { SCHEDULER_INTERVAL_MS: '500', SETTLE_CHUNK: '300' });

    // 마감 전 Redis 순서를 잡아 둔다 (제출은 위에서 끝났다)
    const keys = seasonKeys(IDS.settleDesc, 1);
    const synced = await until(async () => {
        const d = await diff(IDS.settleDesc);
        return d.ready && d.bad === 0 && d.redis === N;
    }, 15000);
    const redisOrder = await R.zRange(keys.board, 0, -1, { REV: true });
    check('T3 마감 전 Redis 순위표 준비', synced >= 0 && redisOrder.length === N);

    const reviewed = await until(async () => {
        const rows = await q('SELECT ranking_id, status FROM ranking_season WHERE ranking_id IN (?) AND season_no = 1', [[IDS.settleDesc, IDS.settleAsc, IDS.settleEmpty]]);
        return rows.length === 3 && rows.every((r) => r.status === 5);
    }, 60000);
    check('T4 세 시즌 모두 REVIEW', reviewed >= 0, `(${reviewed}ms)`);

    const desc = await finalOrder(IDS.settleDesc);
    const contiguous = desc.ranks.every((r, i) => r === i + 1);
    const same = desc.members.length === redisOrder.length && desc.members.every((m, i) => m === redisOrder[i]);
    check('T5 DESC 가순위 1..N 연속, 마감 Redis 순서와 일치 (동점 다수, 청크 300)', contiguous && same,
        `(${desc.members.length}명, 첫 불일치 ${desc.members.findIndex((m, i) => m !== redisOrder[i])})`);

    const ascFinal = await finalOrder(IDS.settleAsc);
    check('T6 ASC 이어받기: 1..N 연속, 기대 순서와 일치', ascFinal.ranks.every((r, i) => r === i + 1) && ascFinal.members.join() === ascExpected.join(),
        `(첫 불일치 ${ascFinal.members.findIndex((m, i) => m !== ascExpected[i])})`);

    const [rv] = await q('SELECT TIMESTAMPDIFF(SECOND, NOW(3), review_until) s FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleDesc]);
    check('T7 review_until = 전이 시각 + review_period', rv.s > 3500 && rv.s <= 3600, `(${rv.s}s 남음)`);
    check('T8 Redis 시즌 키 삭제 (센티넬·순위표)', await R.exists([keys.ready, keys.board, keys.ver]) === 0);
    check('T9 작업 테이블 비움, 정렬 인덱스·settle_slot 제거', await settlingClean());
    check('T10 빈 시즌 REVIEW, entry 0행', (await q('SELECT COUNT(*) n FROM ranking_entry WHERE ranking_id = ?', [IDS.settleEmpty]))[0].n === 0);
    const noPart = await until(async () => (await q('SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleNoPart]))[0]?.status === 5, 15000);
    check('T11 파티션 없는 지난 시즌은 빈 시즌으로 REVIEW, Redis 키 삭제', noPart >= 0 && await R.exists(seasonKeys(IDS.settleNoPart, 1).ready) === 0, `(${noPart}ms)`);
}

// ------------------------------------------------------------------------------------------------ 실행

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
try {
    const times = Number(process.argv[2] ?? 3);
    for (let i = 1; i <= times; i++) {
        console.log(`\n=== run ${i} ===`);
        for (const [name, fn] of [['복구 시나리오', recoveryScenarios], ['락 대기 제한', lockWait], ['API 경유', apiScenarios], ['시즌 스케줄러', schedulerScenarios], ['정산', settlementScenarios]]) {
            console.log(`-- ${name}`);
            await clean();
            try {
                await fn();
            } finally {
                await killAll();
            }
        }
    }
} finally {
    await killAll();
    await clean();
    await R.close();
    await M.end();
    await A.end();
    await LM.end();
}
check('unhandled rejection 없음', unhandled.length === 0, unhandled.map(String).join('; '));
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
(await import(root + 'core/logger.js')).shutdownLogger();
process.exitCode = failed ? 1 : 0;
