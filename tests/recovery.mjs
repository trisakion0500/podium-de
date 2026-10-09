/**
 * 3단계 자가 복구 회귀 테스트 (01_DESIGN 6장, D-60). Redis를 강제로 MySQL과 어긋나게 만들고 복구되는지 본다.
 * 로컬 개발 DB·Redis 전용이다. 운영 DB에 실행하지 않는다.
 *
 * 순서 (프로젝트 루트에서):
 *   npm run build
 *   node tests/recovery.mjs [반복 수, 기본 3]
 *
 * - 워커와 API를 직접 띄우고 끝나면 끈다. API 포트는 TEST_PORT(기본 3199). 강제 종료라 하트비트가 남아,
 *   끝난 뒤 30초 동안은 migrate가 거부된다(05_TROUBLESHOOTING 1.1).
 * - 테스트 랭킹 941~945를 쓰고, 시작 전과 끝난 뒤에 모두 지운다(MySQL 행·파티션, job_state, 제출 이력, Redis 키, 테스트 API 키).
 * - API 키 원문은 메모리에만 두고 출력하지 않는다.
 * - 워커 로그는 logs/app.log.worker.t* 에 남는다. 로그 문구로 판정하는 항목이 있다.
 * - 규모는 시즌당 2,500명이다. 100만 명 규모 수치는 01_DESIGN 1.7의 실측값을 본다.
 * @author trisakion
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const root = new URL('../dist/', import.meta.url).href;
const { createPool, callSp } = await import(root + 'core/db.js');
const { config } = await import(root + 'core/config.js');
const { seasonKeys, createRedis, closeRedis, finishRebuild } = await import(root + 'core/redis.js');
const { composite, startRankingRefresh } = await import(root + 'core/rankings.js');
const { startRecovery } = await import(root + 'worker/recovery.js');
const { hashApiKey } = await import(root + 'api/auth.js');
const { ApiScope } = await import(root + 'core/codes.js');
const { createClient } = await import('redis');

/** 복구 시나리오(BEST·SUM), 락 대기, API 경유(BEST·SUM) */
const IDS = { best: 941, sum: 942, lock: 943, apiBest: 944, apiSum: 945 };
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
    for (const t of ['ranking_season', 'ranking_definition', 'ranking_exclusion', 'job_state'])
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ALL_IDS]);
    await q("DELETE FROM api_credential WHERE key_name LIKE 'rtest-%'");
    await LM.query('DELETE FROM log_ranking_submit WHERE ranking_id IN (?)', [ALL_IDS]);
    for (const id of ALL_IDS)
        for await (const keys of R.scanIterator({ MATCH: `${config.redis.keyPrefix}rk:{${id}}*`, COUNT: 1000 }))
            if (keys.length)
                await R.unlink(keys);
}

/**
 * 테스트 랭킹과 진행 중인 시즌 1을 만든다. 센티넬은 만들지 않는다 — 워커 복구 잡이 만든다(D-60).
 * @param id 랭킹 ID
 * @param updateRule 1:BEST, 2:SUM
 * @returns 없음
 */
async function createRanking(id, updateRule) {
    // score_max 8000: time_bits 40이면 score × 2^40이 2^53 안에 들어야 한다.
    await q(`INSERT INTO ranking_definition (ranking_id, ranking_code, ranking_name, status, update_rule, sort_order, score_max, time_unit, time_bits,
              timezone, start_at, end_at, cycle_type, settle_delay, review_period, history_retention, max_delta, max_submit_per_min, created_at, updated_at)
             VALUES (?, ?, 'rtest', 1, ?, 1, 8000, 1, 40, 'UTC', NOW(3), NULL, 1, 60, 60, 30, NULL, NULL, NOW(3), NOW(3))`, [id, `RT${id}`, updateRule]);
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
 * 워커 로그에서 문구가 나온 횟수.
 * @param id 인스턴스 ID
 * @param text 찾을 문구
 * @returns 횟수
 */
function logCount(id, text) {
    const file = `logs/app.log.worker.${id}`;
    return existsSync(file) ? readFileSync(file, 'utf8').split(text).length - 1 : 0;
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

// ------------------------------------------------------------------------------------------------ 실행

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
try {
    const times = Number(process.argv[2] ?? 3);
    for (let i = 1; i <= times; i++) {
        console.log(`\n=== run ${i} ===`);
        for (const [name, fn] of [['복구 시나리오', recoveryScenarios], ['락 대기 제한', lockWait], ['API 경유', apiScenarios]]) {
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
