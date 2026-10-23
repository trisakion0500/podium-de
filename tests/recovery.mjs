/**
 * 3단계 자가 복구 회귀 테스트 (01_DESIGN 6장, D-60). Redis를 강제로 MySQL과 어긋나게 만들고 복구되는지 본다.
 * 4단계 시즌 스케줄러(01_DESIGN 3.3, 3.5)의 시즌 계산·선행 생성·상태 전이와 정산(7.1~7.6), 결과 조회·보상 전달(7.7, 8.5),
 * 로그 DB 일 파티션 정리·월 테이블 이동(4.5), 시즌 백업 분리(8.2, 8.3), 관리 API·GM 인증(10.4)과 장애 주입(요청 오류, 동시성, 의존 서비스 장애·무응답, 프로세스 강제 종료)도 함께 본다.
 * 로컬 개발 DB·Redis 전용이다. 운영 DB에 실행하지 않는다.
 *
 * 순서 (프로젝트 루트에서):
 *   npm run build
 *   node tests/recovery.mjs [반복 수, 기본 3]
 *   (ONLY=관리처럼 주면 이름에 그 문자열이 든 구간만 돈다)
 *   (KEEP_BACKUP_TABLES=1이면 테스트가 만든 시즌 백업 테이블을 남긴다. 확인한 뒤 지우고 다음 실행을 한다)
 *
 * - 워커와 API·관리 API를 직접 띄우고 끝나면 끈다. API 포트는 TEST_PORT(기본 3199)부터 6개, 관리 API는 그다음 1개. 강제 종료라 하트비트가 남아,
 *   끝난 뒤 30초 동안은 migrate가 거부된다(05_TROUBLESHOOTING 1.1).
 * - 테스트 랭킹 940~971을 쓰고, 시작 전과 끝난 뒤에 모두 지운다(MySQL 행·파티션·시즌 백업 테이블, 보상 구간, Top N, job_state, 제출 이력, Redis 키, 테스트 API 키,
 *   rtest- 관리 계정·세션·감사 로그).
 * - 로그 정리 구간은 개발 로그 DB의 일 파티션을 실제로 만들고(오늘 + 7일까지), 90일이 지난 파티션을 월 테이블로 옮긴다.
 *   테스트가 쓰는 달(100일 전 무렵, 12·13개월 전)의 월 테이블은 시작 전과 끝난 뒤에 지운다.
 * - API 키 원문은 메모리에만 두고 출력하지 않는다.
 * - 워커 로그는 logs/app.log.worker.t* 에 남는다. 로그 문구로 판정하는 항목이 있다.
 * - 진행 상황: 구간 시작·끝에 [경과 mm:ss], 30초마다 "... 진행 중: run N / 구간" 하트비트를 찍는다. 출력이 30초 넘게 멈추면
 *   그 자리에서 멈춘 것이다. 구간이 5분을 넘거나 예외가 나면 ABORTED와 요약을 찍고 종료 코드 1로 끝난다. 워커·API가
 *   스스로 종료하면(기동 실패 등) err 로그의 마지막 ERROR 줄과 함께 FAIL로 찍는다.
 * - 규모는 시즌당 2,500명이다. 100만 명 규모 수치는 01_DESIGN 1.7의 실측값을 본다.
 * @author trisakion
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const root = new URL('../dist/', import.meta.url).href;
const { createPool, callSp } = await import(root + 'core/db.js');
const { config } = await import(root + 'core/config.js');
const { seasonKeys, createRedis, closeRedis, finishRebuild } = await import(root + 'core/redis.js');
const { composite, startRankingRefresh } = await import(root + 'core/rankings.js');
const { startRecovery } = await import(root + 'worker/recovery.js');
const { nextSeason } = await import(root + 'worker/scheduler.js');
const { rewardGaps } = await import(root + 'worker/settle.js');
const { cleanupLogPartitions } = await import(root + 'worker/logcleanup.js');
const { checkJobStall } = await import(root + 'worker/stall.js');
const { expiredMessage, runArchive } = await import(root + 'worker/archive.js');
const { createDeliveryWatch } = await import(root + 'worker/delivery.js');
const { hashApiKey } = await import(root + 'api/auth.js');
const { ApiScope } = await import(root + 'core/codes.js');
const { createClient } = await import('redis');

/** 복구 시나리오(BEST·SUM), 락 대기, API 경유(BEST·SUM), 스케줄러(FIXED, 단일 시즌, 종료), 정산(DESC, ASC 이어받기, 빈 시즌), 보상 전달 */
const IDS = { best: 941, sum: 942, lock: 943, apiBest: 944, apiSum: 945, fixed: 946, single: 947, ended: 948, settleDesc: 949, settleAsc: 950, settleEmpty: 951, settleNoPart: 952, broken: 940,
    finAdd: 953, finAllBanned: 954, finSmall: 955, finPercent: 956, finAlone: 957, finMixed: 958, finMixedSmall: 959, dlv: 960, dlvEmpty: 961, dlvReview: 962, dlvF1: 963, dlvF2: 964,
    fxSum: 965, fxRate: 966, fxPaused: 967, fxSettle: 968, fxBest: 969, arc: 970, arcLast: 971, rkShort: 972, rkExtend: 973, rkOver: 974, rkEnd: 975 };
const ALL_IDS = Object.values(IDS);
/** 관리 API로 등록한 테스트 랭킹의 코드 접두어. ID는 AUTO_INCREMENT라 코드로 찾아 지운다 */
const RK_CODE = 'rtk-';
const N = 2500;
const PORT = Number(process.env.TEST_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;
/** 1이면 테스트가 만든 시즌 백업 테이블을 지우지 않는다 (확인용, 1회 실행 전용 — 다음 실행 전에 지워야 B 구간이 맞는다) */
const KEEP_BACKUP_TABLES = process.env.KEEP_BACKUP_TABLES === '1';
/** 구간 이름에 이 문자열이 든 구간만 돌린다 (고치는 중 빠른 확인용, 예: ONLY=관리). 커밋 전에는 전체를 돌린다 */
const ONLY = process.env.ONLY ?? '';

const M = createPool('MIGRATE');
const A = createPool('APP');
const LM = createPool('MIGRATE', 'LOG');
const LA = createPool('APP', 'LOG');
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
    const ids = [...ALL_IDS, ...(await q('SELECT ranking_id id FROM ranking_definition WHERE ranking_code LIKE ?', [`${RK_CODE}%`])).map((r) => r.id)];
    for (const t of ['ranking_entry', 'ranking_submit_key']) {
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ids]);
        for (const id of ids) {
            const ps = (await q('SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_DESCRIPTION LIKE ?', [t, `(${id},%`]))
                .map((x) => '`' + x.n + '`');
            if (ps.length)
                await q(`ALTER TABLE ${t} DROP PARTITION ${ps.join(', ')}`);
        }
    }
    for (const t of ['ranking_season', 'ranking_definition', 'ranking_reward_tier', 'ranking_season_top', 'ranking_exclusion', 'job_state', 'ranking_entry_settling'])
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [ids]);
    // 정산 도중 끊긴 테스트가 남긴 정렬 인덱스·가상 컬럼 (작업 테이블이 비어 있을 때만 — 다른 시즌 정산 중이면 건드리지 않는다)
    if ((await q('SELECT COUNT(member_id) n FROM ranking_entry_settling'))[0].n === 0) {
        if ((await q("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND INDEX_NAME = 'ix_settle_order'")).length)
            await q('ALTER TABLE ranking_entry_settling DROP INDEX ix_settle_order');
        if ((await q("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_entry_settling' AND COLUMN_NAME = 'settle_slot'")).length)
            await q('ALTER TABLE ranking_entry_settling DROP COLUMN settle_slot');
    }
    for (const { n } of await q("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME REGEXP '^ranking_(entry|submit_key)_r[0-9]+_s[0-9]+$'"))
        if (!KEEP_BACKUP_TABLES && ALL_IDS.includes(Number(/_r(\d+)_s/.exec(n)[1])))
            await q(`DROP TABLE \`${n}\``);
    await q("DELETE FROM api_credential WHERE key_name LIKE 'rtest-%'");
    // 관리 계정은 지우지 않는 설계지만 테스트 계정은 픽스처라 지운다. 감사 로그도 그 계정·대상 행만 지운다.
    const adminIds = (await q("SELECT admin_account_id id FROM admin_account WHERE login_id LIKE 'rtest-%'")).map((r) => r.id);
    if (adminIds.length) {
        await LM.query("DELETE FROM log_admin_audit WHERE admin_account_id IN (?) OR (target_type = 'account' AND target_id IN (?))", [adminIds, adminIds.map(String)]);
        await q('DELETE FROM admin_session WHERE admin_account_id IN (?)', [adminIds]);
        await q('DELETE FROM admin_account WHERE admin_account_id IN (?)', [adminIds]);
    }
    await LM.query("DELETE FROM log_admin_audit WHERE login_id LIKE 'rtest-%'");
    await LM.query('DELETE FROM log_ranking_submit WHERE ranking_id IN (?)', [ids]);
    for (const id of ids)
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
    spawnTracked(id, 'worker', { RECOVERY_INTERVAL_MS: '1000', RECOVERY_MARGIN_SEC: '5', ...env });
}

/**
 * 워커·API를 띄우고, 테스트가 끄기 전에 스스로 종료하면(기동 실패 등) 바로 FAIL로 알린다.
 * 스키마 불일치 같은 기동 거부가 "응답 없음"이나 시간 초과로 묻히지 않게 err 로그의 마지막 ERROR 줄을 함께 찍는다.
 * @param id 인스턴스 ID (로그 파일 suffix)
 * @param kind 'worker' | 'api'
 * @param env 추가 환경 변수
 * @returns 없음
 */
function spawnTracked(id, kind, env = {}) {
    const p = spawn(process.execPath, [`dist/${kind}.js`], { stdio: 'ignore', env: { ...process.env, INSTANCE_ID: id, ...env } });
    p.on('exit', (code) => {
        if (p.stopping)
            return;
        const errLog = `logs/err.log.${kind}.${id}`;
        const last = existsSync(errLog) ? readFileSync(errLog, 'utf8').split('\n').filter((l) => l.includes('[ERROR]')).at(-1) ?? '' : '';
        check(`프로세스 ${kind} ${id} 예기치 않은 종료 (code ${code})`, false, last.slice(0, 300));
    });
    workers.set(id, p);
}

/**
 * 띄운 워커·API를 모두 끈다.
 * @returns 없음
 */
async function killAll() {
    for (const id of [...workers.keys()])
        stopProcess(id);
    await sleep(500);
    // 프록시가 열려 있으면 테스트 프로세스가 끝나지 않는다
    for (const p of [...proxies])
        await p.close();
}

const proxies = new Set();

/**
 * 프로세스와 의존 서비스(Redis·MySQL) 사이에 끼우는 TCP 프록시. 공유 인스턴스를 내리지 않고 이 프록시를 거치는 프로세스에만
 * 실행 중 장애를 만든다. 접속 정보는 포트만 바뀌고 자격 증명은 환경 변수 그대로다.
 * - hang(): 연결은 둔 채 양방향 전달을 멈춘다(서버가 바빠 응답하지 않는 상태). up()이 쌓인 바이트를 순서대로 보낸다.
 * - down(): 연결을 모두 끊고 수신을 닫는다(연결 거부). up()이 같은 포트로 다시 연다.
 * @param host 대상 호스트
 * @param port 대상 포트
 * @returns { port, hang, down, up, close }
 */
async function tcpProxy(host, port) {
    const pairs = new Set();
    const held = [];
    let hold = false;
    const server = createServer((c) => {
        const s = connect(port, host);
        const pair = [c, s];
        pairs.add(pair);
        for (const [from, to] of [[c, s], [s, c]])
            from.on('data', (d) => (hold ? held.push([to, d]) : to.write(d)));
        const end = () => {
            c.destroy();
            s.destroy();
            pairs.delete(pair);
        };
        for (const x of pair) {
            x.on('error', end);
            x.on('close', end);
        }
    });
    const listen = (p) => new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(p, '127.0.0.1', () => {
            server.off('error', fail);
            ok();
        });
    });
    await listen(0);
    const self = {
        port: server.address().port,
        hang() {
            hold = true;
        },
        async down() {
            hold = false;
            held.length = 0;
            for (const pair of pairs)
                pair.forEach((x) => x.destroy());
            pairs.clear();
            if (server.listening)
                await new Promise((ok) => server.close(() => ok()));
        },
        async up() {
            hold = false;
            for (const [to, d] of held.splice(0))
                if (!to.destroyed)
                    to.write(d);
            if (!server.listening)
                await listen(self.port);
        },
        async close() {
            proxies.delete(self);
            await self.down();
        },
    };
    proxies.add(self);
    return self;
}

/**
 * 테스트가 의도해서 프로세스 하나를 끈다 (예기치 않은 종료로 세지 않는다).
 * @param id 인스턴스 ID
 * @returns 없음
 */
function stopProcess(id) {
    const p = workers.get(id);
    if (!p)
        return;
    p.stopping = true;
    p.kill();
    workers.delete(id);
}

/**
 * 워커·API 로그에서 문구가 나온 횟수. 날짜 회전된 파일(app.log.{kind}.{id}.YYYYMMDD)까지 합친다 — 날짜가 바뀐 뒤 첫 기록에서
 * 현재 파일이 회전되면 현재 파일만 센 값은 줄어들어 "증가" 판정이 틀린다.
 * @param id 인스턴스 ID
 * @param text 찾을 문구
 * @param kind 'worker' | 'api'
 * @returns 횟수
 */
function logCount(id, text, kind = 'worker') {
    const base = `app.log.${kind}.${id}`;
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

    stopProcess('t1');
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
    spawnTracked('tapi', 'api', { API_PORT: String(PORT) });

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
    const [{ n }] = await q('SELECT COUNT(member_id) n FROM ranking_entry_settling');
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
    check('T10 빈 시즌 REVIEW, entry 0행', (await q('SELECT COUNT(member_id) n FROM ranking_entry WHERE ranking_id = ?', [IDS.settleEmpty]))[0].n === 0);
    const noPart = await until(async () => (await q('SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleNoPart]))[0]?.status === 5, 15000);
    check('T11 파티션 없는 지난 시즌은 빈 시즌으로 REVIEW, Redis 키 삭제', noPart >= 0 && await R.exists(seasonKeys(IDS.settleNoPart, 1).ready) === 0, `(${noPart}ms)`);

    await killAll();
    await finalizeScenarios(redisOrder);
}

/**
 * 확정 시나리오 (01_DESIGN 7.5, 7.6). 정산 시나리오가 REVIEW로 만든 시즌을 이어서 쓴다.
 * - DESC: 제재 2명(이 시즌, 전 시즌 0) 제외, 순위 재부여, 보상 구간(RANK, PERCENT, 겹침), Top N. 손으로 전이와 한 청크만
 *   한 상태(워커가 도중에 죽은 상태)에서 워커가 이어받는다. 전이 뒤 구간을 고쳐도 스냅샷으로 판정한다.
 * - ASC: 검수 기간이 지났어도 보류면 REVIEW에 머문다. 빈 시즌: 참가자 0으로 DELIVERING.
 * @param redisOrder 정산 시나리오에서 잡은 DESC 시즌의 마감 Redis 순서 (= 가순위 순서)
 * @returns 없음
 */
async function finalizeScenarios(redisOrder) {
    const id = IDS.settleDesc;
    const tiers = [[1, 1, 1, 10, 'TOP10'], [2, 2, 1, 10, 'P10'], [3, 1, 5, 400, 'R400'], [4, 2, 11, 30, 'P30']];
    await q('INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code) VALUES ?', [tiers.map((x) => [id, ...x])]);
    const banned = [redisOrder[2], redisOrder[49]];
    await q(`INSERT INTO ranking_exclusion (ranking_id, season_no, member_id, reason, created_by, created_at)
             VALUES (?, 1, ?, 'test', 'rt', NOW(3)), (?, 0, ?, 'test', 'rt', NOW(3)), (?, 1, 'nobody', 'test', 'rt', NOW(3))`, [id, banned[0], id, banned[1], id]);

    await q('UPDATE ranking_season SET review_until = NOW(3) - INTERVAL 1 SECOND, review_hold = 1 WHERE ranking_id IN (?) AND season_no = 1', [[id, IDS.settleAsc]]);
    await q('UPDATE ranking_season SET review_until = NOW(3) - INTERVAL 1 SECOND WHERE ranking_id = ? AND season_no = 1', [IDS.settleEmpty]);
    const held = await callSp(A, 'SP_START_FINALIZING', [id, 1]);
    await q('UPDATE ranking_season SET review_hold = 0 WHERE ranking_id = ? AND season_no = 1', [id]);
    await q('UPDATE ranking_season SET review_until = NOW(3) + INTERVAL 1 HOUR WHERE ranking_id = ? AND season_no = 1', [id]);
    const early = await callSp(A, 'SP_START_FINALIZING', [id, 1]);
    await q('UPDATE ranking_season SET review_until = NOW(3) - INTERVAL 1 SECOND WHERE ranking_id = ? AND season_no = 1', [id]);
    const start = await callSp(A, 'SP_START_FINALIZING', [id, 1]);
    check('F1 보류 1014, 검수 기간 전 1014, 이후 FINALIZING', held.result === 1014 && early.result === 1014 && start.result === 0, `(${held.result}, ${early.result}, ${start.result})`);

    // 워커가 제재 제외와 한 청크만 하고 죽은 상태. 전이 뒤 구간 변경은 판정에 반영되지 않아야 한다
    const ex = await callSp(A, 'SP_UPDATE_FINAL_EXCLUSION', [id, 1]);
    const part = await callSp(A, 'SP_UPDATE_FINAL_RANK', [id, 1, 0, 100]);
    await q("UPDATE ranking_reward_tier SET reward_code = 'CHANGED' WHERE ranking_id = ? AND tier_no = 1", [id]);
    check('F2 제재 제외 후 참가자 N-2, 한 청크 100행', ex.rows[0]?.participant_count === N - 2 && part.rows[0]?.ranked_count === 100, `(${ex.rows[0]?.participant_count})`);

    startWorker('t8', { SCHEDULER_INTERVAL_MS: '500', SETTLE_CHUNK: '300' });
    const delivering = await until(async () => {
        const rows = await q('SELECT status FROM ranking_season WHERE ranking_id IN (?) AND season_no = 1', [[id, IDS.settleEmpty]]);
        return rows.length === 2 && rows.every((r) => r.status === 7);
    }, 30000);
    check('F3 DESC·빈 시즌 DELIVERING', delivering >= 0, `(${delivering}ms)`);

    const P = N - 2;
    const expected = redisOrder.filter((m) => !banned.includes(m));
    // RANK 구간이 PERCENT보다 먼저, 같은 종류는 tier_no 순. PERCENT는 내 앞 사람 비율 (r-1)/P가 [from-1, to)% 안 (D-69)
    const reward = (r) => [...tiers].sort((a, b) => a[1] - b[1] || a[0] - b[0]).find(([, type, from, to]) =>
        type === 1 ? r >= from && r <= to : (from - 1) * P <= (r - 1) * 100 && (r - 1) * 100 < to * P)?.[4] ?? null;
    const rows = await q('SELECT member_id, final_rank, reward_code, reward_status, sanctioned FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND final_rank IS NOT NULL ORDER BY final_rank', [id]);
    const rankOk = rows.length === P && rows.every((r, i) => r.final_rank === i + 1 && r.member_id === expected[i]);
    check('F4 순위 재부여: 1..N-2 연속, 가순위 순서에서 제재만 빠짐 (이어받기)', rankOk, `(${rows.length}행, 첫 불일치 ${rows.findIndex((r, i) => r.member_id !== expected[i])})`);
    const bad = rows.find((r) => r.reward_code !== reward(r.final_rank) || r.reward_status !== (reward(r.final_rank) ? 1 : 0) || r.sanctioned !== 0);
    check('F5 보상 판정: RANK·PERCENT, 겹치면 RANK 먼저·같은 종류는 작은 구간 번호, 전이 시 스냅샷 (CHANGED 없음)', !bad, bad ? `(rank ${bad.final_rank}: ${bad.reward_code})` : `(PENDING ${rows.filter((r) => r.reward_status === 1).length})`);

    const sanc = await q('SELECT final_rank, reward_code, reward_status, sanctioned FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id IN (?)', [id, banned]);
    const [season] = await q('SELECT participant_count, JSON_LENGTH(tier_snapshot) tiers FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [id]);
    check('F6 제재 행 final_rank NULL·sanctioned 1·REJECTED, participant_count 기록', sanc.length === 2 && sanc.every((r) => r.final_rank === null && r.sanctioned === 1 && r.reward_status === 3 && r.reward_code === null)
        && season.participant_count === P && season.tiers === tiers.length);

    const top = await q('SELECT final_rank, member_id FROM ranking_season_top WHERE ranking_id = ? AND season_no = 1 ORDER BY final_rank', [id]);
    check('F7 Top N: 상위 top_size(100)행, 확정 순위와 같음', top.length === 100 && top.every((r, i) => r.final_rank === i + 1 && r.member_id === expected[i]));

    const [empty] = await q('SELECT participant_count, JSON_LENGTH(tier_snapshot) tiers FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleEmpty]);
    const [asc] = await q('SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.settleAsc]);
    check('F8 빈 시즌 참가자 0·구간 없음 빈 배열, 보류 시즌은 REVIEW 유지', empty.participant_count === 0 && empty.tiers === 0 && asc.status === 5, `(${empty.participant_count}, ${empty.tiers}, ${asc.status})`);

    await killAll();
    await finalizeEdges();
}

/**
 * 가순위가 1..n으로 매겨진 REVIEW 시즌을 직접 만든다 (검수 기간 지남). 멤버 f0..f{n-1}이 순서대로 1위..n위다.
 * @param id 랭킹 ID
 * @param n 행 수
 * @param tiers 보상 구간 [tier_no, range_type, from, to, code] 목록
 * @returns 없음
 */
async function createReviewSeason(id, n, tiers = []) {
    await createDefinition(id);
    await createSeason(id, 1, -60, -30, 5);
    await q('UPDATE ranking_season SET review_until = NOW(3) - INTERVAL 1 SECOND WHERE ranking_id = ? AND season_no = 1', [id]);
    for (let i = 0; i < n; i += 5000) {
        const rows = [];
        for (let j = i; j < Math.min(n, i + 5000); j++)
            rows.push([id, 1, `f${j}`, n - j, new Date(), 1, new Date(), j + 1]);
        await q('INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at, final_rank) VALUES ?', [rows]);
    }
    if (tiers.length)
        await q('INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code) VALUES ?', [tiers.map((x) => [id, ...x])]);
}

/**
 * 제재를 이 시즌(1)에 등록한다.
 * @param id 랭킹 ID
 * @param members 멤버 ID 목록
 * @returns 없음
 */
async function ban(id, members) {
    await q("INSERT INTO ranking_exclusion (ranking_id, season_no, member_id, reason, created_by, created_at) VALUES ?",
        [members.map((m) => [id, 1, m, 'test', 'rt', new Date()])]);
}

/**
 * 워커 finalize()와 같은 순서로 SP를 직접 부른다 (전이 → 제재 제외 → 재부여 청크 → DELIVERING).
 * @param id 랭킹 ID
 * @param chunk 청크 크기
 * @param stopAfter 이만큼 청크를 한 뒤 DELIVERING 없이 멈춤 (워커가 도중에 죽은 상태, 기본: 끝까지)
 * @returns DELIVERING 전이 RESULT (멈췄으면 null)
 */
async function runFinalize(id, chunk = 50, stopAfter = Infinity) {
    await callSp(A, 'SP_START_FINALIZING', [id, 1]);
    await callSp(A, 'SP_UPDATE_FINAL_EXCLUSION', [id, 1]);
    let base = 0;
    for (let c = 0; c < stopAfter; c++) {
        const n = (await callSp(A, 'SP_UPDATE_FINAL_RANK', [id, 1, base, chunk])).rows[0].ranked_count;
        if (n === 0)
            break;
        base += n;
    }
    return stopAfter === Infinity ? (await callSp(A, 'SP_UPDATE_SEASON_DELIVERING', [id, 1])).result : null;
}

/**
 * 확정 경계 시나리오 (SP 직접 호출, 워커 없음).
 * - 재부여 도중 DELIVERING 1015, 그 사이 추가된 제재(처리한 구간·남은 구간)를 다시 돌아 반영, 재호출 멱등
 * - 전원 제재(참가자 0), 참가자 수 < top_size
 * - PERCENT 경계(D-69): 상위 t% 누적 인원 ceil(P×t/100), 참가자 1명이면 1위가 최상위 구간
 * @returns 없음
 */
async function finalizeEdges() {
    // 재부여 도중 중단 + 제재 추가
    await createReviewSeason(IDS.finAdd, 200);
    await ban(IDS.finAdd, ['f9']);
    await runFinalize(IDS.finAdd, 50, 1);
    const early = await callSp(A, 'SP_UPDATE_SEASON_DELIVERING', [IDS.finAdd, 1]);
    await ban(IDS.finAdd, ['f20', 'f99']); // f20은 처리한 청크(새 20위), f99는 남은 구간
    const done = await runFinalize(IDS.finAdd);
    const out = await q('SELECT member_id, final_rank FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND final_rank IS NOT NULL ORDER BY final_rank', [IDS.finAdd]);
    const expect = Array.from({ length: 200 }, (_, j) => `f${j}`).filter((m) => !['f9', 'f20', 'f99'].includes(m));
    check('F9 재부여 도중 DELIVERING 1015, 도중 추가된 제재는 다시 돌아 반영 (1..197 연속, 원래 순서)', early.result === 1015 && done === 0
        && out.length === 197 && out.every((r, i) => r.final_rank === i + 1 && r.member_id === expect[i]), `(${early.result}, ${done}, ${out.length}행)`);

    const again = [(await callSp(A, 'SP_START_FINALIZING', [IDS.finAdd, 1])).result, (await callSp(A, 'SP_UPDATE_SEASON_DELIVERING', [IDS.finAdd, 1])).result];
    const [{ n: topN }] = await q('SELECT COUNT(final_rank) n FROM ranking_season_top WHERE ranking_id = ?', [IDS.finAdd]);
    check('F10 DELIVERING 뒤 전이 SP 재호출은 성공(0), Top N 중복 적재 없음', again.every((r) => r === 0) && topN === 100, `(${again}, top ${topN})`);

    // 전원 제재, 참가자 수 < top_size
    await createReviewSeason(IDS.finAllBanned, 5, [[1, 1, 1, 3, 'A']]);
    await ban(IDS.finAllBanned, ['f0', 'f1', 'f2', 'f3', 'f4']);
    const allBanned = await runFinalize(IDS.finAllBanned);
    const [ab] = await q(`SELECT s.status, s.participant_count p, (SELECT COUNT(t.final_rank) FROM ranking_season_top t WHERE t.ranking_id = s.ranking_id) top,
                                 (SELECT COUNT(e.member_id) FROM ranking_entry e WHERE e.ranking_id = s.ranking_id AND e.reward_status = 3) rejected
                            FROM ranking_season s WHERE s.ranking_id = ?`, [IDS.finAllBanned]);
    await createReviewSeason(IDS.finSmall, 5, [[1, 1, 1, 3, 'A']]);
    await ban(IDS.finSmall, ['f1']);
    const small = await runFinalize(IDS.finSmall);
    const top = await q('SELECT final_rank, member_id FROM ranking_season_top WHERE ranking_id = ? ORDER BY final_rank', [IDS.finSmall]);
    check('F11 전원 제재: 참가자 0·Top N 0·전원 REJECTED로 DELIVERING / 참가자 4 < top_size: Top N 4행', allBanned === 0 && ab.status === 7 && ab.p === 0 && ab.top === 0 && ab.rejected === 5
        && small === 0 && top.map((r) => `${r.final_rank}:${r.member_id}`).join() === '1:f0,2:f2,3:f3,4:f4', `(${JSON.stringify(ab)}, ${top.length})`);

    // PERCENT 경계 (D-69): 상위 1% 누적 인원은 ceil(P/100). P=20001이면 201명(200.01을 올림), 202위부터 밖
    const P = 20001;
    await createReviewSeason(IDS.finPercent, P, [[1, 2, 1, 1, 'IN'], [2, 2, 2, 100, 'REST']]);
    const pct = await runFinalize(IDS.finPercent, 5000);
    const got = await q('SELECT final_rank, reward_code FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND final_rank IN (201, 202, ?) ORDER BY final_rank', [IDS.finPercent, P]);
    check('F12 PERCENT 경계: 상위 1%는 ceil(P/100)=201명, 202위·꼴찌는 다음 구간', pct === 0 && got.map((x) => x.reward_code).join() === 'IN,REST,REST',
        `(판정 ${got.map((x) => `${x.final_rank}:${x.reward_code}`)})`);
    // 혼자 참가한 시즌: 1위는 앞 사람 0%라 최상위 구간
    await createReviewSeason(IDS.finAlone, 1, [[1, 2, 1, 1, 'IN'], [2, 2, 2, 100, 'REST']]);
    const alone = await runFinalize(IDS.finAlone);
    const [solo] = await q('SELECT reward_code FROM ranking_entry WHERE ranking_id = ? AND season_no = 1', [IDS.finAlone]);
    check('F13 참가자 1명이면 1위는 상위 1% 구간', alone === 0 && solo?.reward_code === 'IN', `(${solo?.reward_code})`);

    // 상위 RANK + 하위 PERCENT. tier_no를 거꾸로 넣고(PERCENT가 작은 번호) PERCENT를 11%부터 둔 설정
    const inPct = (r, n, f, t) => (Math.max(f, 1) - 1) * n <= (r - 1) * 100 && (r - 1) * 100 < t * n;
    const expectMixed = (mixed, n) => (r) => {
        const hit = [...mixed].sort((a, b) => a[1] - b[1] || a[0] - b[0])
            .find(([, type, f, t]) => type === 1 ? r >= f && r <= t : inPct(r, n, f, t));
        return hit?.[4] ?? null;
    };
    const mixedGap = [[1, 2, 11, 50, 'P50'], [2, 2, 51, 100, 'P100'], [3, 1, 1, 1, 'R1'], [4, 1, 2, 10, 'R10']];
    const mixedOk = [[1, 1, 1, 1, 'R1'], [2, 1, 2, 3, 'R3'], [3, 2, 1, 10, 'P10'], [4, 2, 11, 100, 'REST']];
    let mixedBad = 0;
    for (const [mid, n, tiersX] of [[IDS.finMixed, 1000, mixedGap], [IDS.finMixedSmall, 7, mixedOk]]) {
        await createReviewSeason(mid, n, tiersX);
        await runFinalize(mid, 300);
        const exp = expectMixed(tiersX, n);
        const got2 = await q('SELECT final_rank, reward_code FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 ORDER BY final_rank', [mid]);
        mixedBad += got2.filter((x) => x.reward_code !== exp(x.final_rank)).length + (got2.length === n ? 0 : 1);
    }
    const [{ r1, none }] = await q("SELECT MAX(reward_code = 'R1' AND final_rank = 1) r1, SUM(reward_code IS NULL) none FROM ranking_entry WHERE ranking_id = ?", [IDS.finMixed]);
    check('F14 상위 RANK + 하위 PERCENT: tier_no 역순이어도 RANK 우선, 11~100위만 보상 없음 (P=1000), P=7 공백 없음', mixedBad === 0 && r1 === 1 && Number(none) === 90, `(불일치 ${mixedBad}, 보상 없음 ${none})`);

    // 공백 계산(rewardGaps)이 SP 판정 규칙의 전수 결과와 같은지 — 구성 3개 × P 1..300
    const toTiers = (xs) => xs.map(([tier_no, range_type, range_from, range_to]) => ({ tier_no, range_type, range_from, range_to }));
    let gapBad = 0;
    for (const cfg of [mixedGap, mixedOk, [[1, 1, 5, 8, 'A'], [2, 2, 20, 30, 'B'], [3, 2, 0, 3, 'C']]])
        for (let n = 1; n <= 300; n++) {
            const covered = Array.from({ length: n }, (_, i) => expectMixed(cfg, n)(i + 1) !== null);
            const last = covered.lastIndexOf(true);
            const brute = [];
            for (let i = 0; i < last; i++)
                if (!covered[i])
                    brute.length && brute.at(-1)[1] === i ? (brute.at(-1)[1] = i + 1) : brute.push([i + 1, i + 1]);
            if (JSON.stringify(brute) !== JSON.stringify(rewardGaps(toTiers(cfg), n)))
                gapBad++;
        }
    check('F15 보상 공백 계산이 판정 규칙 전수 결과와 일치 (P 1..300, 구성 3개), P=1000 역순 설정은 11..100', gapBad === 0
        && JSON.stringify(rewardGaps(toTiers(mixedGap), 1000)) === '[[11,100]]', `(불일치 ${gapBad})`);
}

// ------------------------------------------------------------------------------------------------ 7. 결과 조회·보상 전달 (01_DESIGN 7.7, 8.5)

/**
 * 결과·Top N·보상 API와 워커 SETTLED 전이를 본다.
 * 시즌 dlv: 10명, 보상 TOP5(1~5위), f2 제재(REJECTED), 확정 뒤 f4 보류 → 전달 대상 f0 f1 f3 f5. dlvEmpty: 빈 시즌. dlvReview: 확정 전.
 * @returns 없음
 */
async function deliveryScenarios() {
    await createReviewSeason(IDS.dlv, 10, [[1, 1, 1, 5, 'TOP5']]);
    await ban(IDS.dlv, ['f2']);
    await createReviewSeason(IDS.dlvEmpty, 0);
    await createReviewSeason(IDS.dlvReview, 3);
    const fin = [await runFinalize(IDS.dlv), await runFinalize(IDS.dlvEmpty)];
    // 오류 주입용 시즌(deliveryFaults). API가 랭킹 정의를 기동 때 읽으므로(D-56) API보다 먼저 만든다
    for (const id of [IDS.dlvF1, IDS.dlvF2]) {
        await createReviewSeason(id, 10, [[1, 1, 1, 5, 'TOP5']]);
        await runFinalize(id);
    }
    await q('UPDATE ranking_entry SET reward_held = 1 WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.dlv, 'f4']);

    const mk = async (name, scopes) => {
        const key = randomBytes(32).toString('base64url');
        await callSp(M, 'SP_INSERT_API_CREDENTIAL', [name, hashApiKey(key), scopes]);
        return key;
    };
    const readKey = await mk('rtest-read', ApiScope.READ);
    const rewardKey = await mk('rtest-reward', ApiScope.REWARD);
    // 처리 제한 시간을 줄여 ack 응답 유실(2005)을 실제로 만든다 (R10)
    spawnTracked('tapi2', 'api', { API_PORT: String(PORT), API_TIMEOUT_MS: '3000' });
    const call = async (path, key, body) => (await fetch(BASE + path, body === undefined ? { headers: { 'x-api-key': key } }
        : { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) })).json();
    const up = await until(async () => {
        try {
            return (await call('/v1/rewards/pending', rewardKey)).result === 0;
        } catch {
            return false; // 기동 전 연결 거부
        }
    }, 30000);
    check('R0 확정 2시즌 DELIVERING, API 기동', fin.every((r) => r === 0) && up >= 0, `(${fin}, ${up}ms)`);

    const s = `/v1/rankings/${IDS.dlv}/seasons/1`;
    const page = await call(`${s}/results?offset=1&size=3`, readKey);
    const tail = await call(`${s}/results?offset=9&size=3`, readKey);
    const notFinal = await call(`/v1/rankings/${IDS.dlvReview}/seasons/1/results`, readKey);
    const noSeason = await call(`/v1/rankings/${IDS.dlv}/seasons/99/results`, readKey);
    check('R1 결과 페이지: 참가자 9, 2~4위(f1 f3 f4), 범위 밖 빈 배열, 확정 전 1003, 시즌 없음 1002',
        page.data?.participantCount === 9 && page.data.items.map((x) => `${x.rank}:${x.memberId}:${x.rewardCode}`).join() === '2:f1:TOP5,3:f3:TOP5,4:f4:TOP5'
        && tail.data?.items.length === 0 && tail.data.participantCount === 9 && notFinal.result === 1003 && noSeason.result === 1002,
        `(${JSON.stringify(page.data?.items?.map((x) => x.memberId))}, ${notFinal.result}, ${noSeason.result})`);

    const banned = await call(`${s}/results/f2`, readKey);
    const none = await call(`${s}/results/nobody`, readKey);
    const first = await call(`${s}/results/f0`, readKey);
    check('R2 내 결과: 제재 rank null·REJECTED, 기록 없음 null, 1위 TOP5·전달 전',
        banned.data?.rank === null && banned.data.rewardStatus === 3 && banned.data.sanctioned === true
        && none.data?.rank === null && none.data.score === null && first.data?.rank === 1 && first.data.rewardCode === 'TOP5' && first.data.rewardStatus === 1,
        `(${JSON.stringify(banned.data)})`);

    const top = await call(`${s}/top?offset=1&size=2`, readKey);
    const topReview = await call(`/v1/rankings/${IDS.dlvReview}/seasons/1/top`, readKey);
    check('R3 Top N 페이지 2~3위, 확정 전은 빈 배열', top.data?.items.map((x) => `${x.rank}:${x.memberId}`).join() === '2:f1,3:f3' && topReview.data?.items.length === 0);

    const pages = [];
    for (let cursor = '', i = 0; i < 5; i++) {
        const r = await call(`${s}/rewards?size=2${cursor ? `&cursor=${cursor}` : ''}`, rewardKey);
        pages.push(r.data.items.map((x) => x.memberId).join('+'));
        cursor = r.data.nextCursor;
        if (!cursor)
            break;
    }
    const wrongScope = await call(`${s}/rewards`, readKey);
    const listReview = await call(`/v1/rankings/${IDS.dlvReview}/seasons/1/rewards`, rewardKey);
    check('R4 보상 목록 커서: 보류·제재 제외 f0+f1 / f3+f5 / 빈 페이지, read 키 2003, 확정 전 1003',
        pages.join(' / ') === 'f0+f1 / f3+f5 / ' && wrongScope.result === 2003 && listReview.result === 1003, `(${pages.join(' / ')})`);

    const pending = await call('/v1/rewards/pending', rewardKey);
    const mine = (pending.data?.seasons ?? []).filter((x) => [IDS.dlv, IDS.dlvEmpty].includes(x.rankingId)).map((x) => `${x.rankingId}:${x.remaining}`).sort().join();
    check('R5 전달 대기 시즌: dlv 남은 4, 빈 시즌 0', mine === [`${IDS.dlv}:4`, `${IDS.dlvEmpty}:0`].sort().join(), `(${mine})`);

    const ackBody = { memberIds: ['f0', 'f1', 'f2', 'f4', 'nobody', 'F3'] };
    const ack = await call(`${s}/rewards/ack`, rewardKey, ackBody);
    const [{ at1 }] = await q('SELECT delivered_at at1 FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.dlv, 'f0']);
    await sleep(20);
    const replay = await call(`${s}/rewards/ack`, rewardKey, ackBody);
    const [{ at2 }] = await q('SELECT delivered_at at2 FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.dlv, 'f0']);
    const ackReview = await call(`/v1/rankings/${IDS.dlvReview}/seasons/1/rewards/ack`, rewardKey, { memberIds: ['f0'] });
    const tooMany = await call(`${s}/rewards/ack`, rewardKey, { memberIds: Array.from({ length: 1001 }, (_, i) => `m${i}`) });
    const notApplied = (r) => [...(r.data?.notApplied ?? [])].sort().join();
    check('R6 ack: 보류·제재·없음·대소문자 다른 ID는 notApplied, 재시도 같은 응답·delivered_at 유지, 확정 전 1003, 1001개 2001',
        notApplied(ack) === 'F3,f2,f4,nobody' && notApplied(replay) === notApplied(ack) && at1 !== null && at1.getTime() === at2.getTime()
        && ackReview.result === 1003 && tooMany.result === 2001, `(${notApplied(ack)}, ${ackReview.result}, ${tooMany.result})`);

    // 남은 f3 f5까지 ack → 워커 첫 주기에 두 시즌 SETTLED (보류 f4는 PENDING으로 남는다)
    await call(`${s}/rewards/ack`, rewardKey, { memberIds: ['f3', 'f5'] });
    const early = await callSp(A, 'SP_UPDATE_SEASON_SETTLED', [IDS.dlvReview, 1]);
    startWorker('t9');
    const settled = await until(async () => {
        const rows = await q('SELECT status, settled_at FROM ranking_season WHERE ranking_id IN (?) AND season_no = 1', [[IDS.dlv, IDS.dlvEmpty]]);
        return rows.length === 2 && rows.every((r) => r.status === 8 && r.settled_at !== null);
    }, 30000);
    const after = await call(`${s}/rewards/ack`, rewardKey, { memberIds: ['f0'] });
    const [{ held }] = await q('SELECT reward_status held FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.dlv, 'f4']);
    check('R7 남은 대상 0 → 워커가 SETTLED (빈 시즌 포함), 보류는 PENDING 유지, SETTLED 뒤 ack 재시도 성공, 확정 전 시즌 전이 1003',
        settled >= 0 && after.result === 0 && notApplied(after) === '' && held === 1 && early.result === 1003, `(${settled}ms, ${early.result})`);

    // 경고 판정 (createDeliveryWatch): 정체 1회, 변화 시 해소, 사라진 시즌은 잊음, 적체 시작·해소 각 1회
    const w = createDeliveryWatch(1000, 2);
    const a = { rankingId: 1, seasonNo: 1, remaining: 5 };
    const ev = [
        w([a], 1, 0), w([a], 1, 500), w([a], 3, 1500), w([a], 3, 3000),
        w([{ ...a, remaining: 4 }], 3, 3500), w([], 1, 4000), w([a], 1, 4100), w([a], 1, 4600),
    ];
    const flat = ev.map((e) => `${e.stalled.length}${e.recovered.length}${e.backlog === null ? '-' : e.backlog ? 'B' : 'b'}`).join(' ');
    check('R8 경고 판정: 1초 정체 1회·변화 시 해소·재등장은 새로 잼, 적체(>2) 시작·해소 1회', flat === '00- 00- 10B 00- 01- 00b 00- 00-', `(${flat})`);

    await stopProcess('t9');
    await deliveryFaults(call, rewardKey, notApplied);
}

/**
 * 보상 전달 오류 주입: 동시 중복 ack, 락 대기로 응답이 시간 초과(2005)된 뒤 커밋, 데드락(50001) 후 재시도,
 * 워커가 실제로 남기는 정체·적체·재개·SETTLED 로그. 시즌 F1·F2(deliveryScenarios가 DELIVERING으로 만들어 둠): 10명, TOP5(f0~f4) 대상.
 * @param call API 호출 함수 (경로, 키, 바디)
 * @param rewardKey reward 권한 키
 * @param notApplied 응답의 notApplied를 정렬해 이은 문자열
 * @returns 없음
 */
async function deliveryFaults(call, rewardKey, notApplied) {
    const ack = (id, memberIds) => call(`/v1/rankings/${id}/seasons/1/rewards/ack`, rewardKey, { memberIds });
    const entry = async (id, m) => (await q('SELECT reward_status, delivered_at FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [id, m]))[0];

    // 게임 서버 인스턴스 여럿이 같은 목록을 동시에 ack. 잘못된 JSON 바디는 2001
    const same = await Promise.all(Array.from({ length: 5 }, () => ack(IDS.dlvF1, ['f0'])));
    const bad = await (await fetch(`${BASE}/v1/rankings/${IDS.dlvF1}/seasons/1/rewards/ack`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': rewardKey }, body: '{"memberIds": [',
    })).json();
    check('R9 같은 ack 5개 동시: 모두 성공·notApplied 없음, 깨진 JSON 2001', same.every((r) => r.result === 0 && notApplied(r) === '') && (await entry(IDS.dlvF1, 'f0')).reward_status === 2
        && bad.result === 2001, `(${same.map((r) => r.result)}, ${bad.result})`);

    // 다른 세션이 f1 행을 잠근 동안 ack → API는 3초에 2005, 잠금이 풀리면 SP가 이어서 커밋한다 (응답 유실)
    const holder = await M.getConnection();
    let lost;
    let committed;
    try {
        await holder.query('START TRANSACTION');
        await holder.query("SELECT member_id FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = 'f1' FOR UPDATE", [IDS.dlvF1]);
        lost = await ack(IDS.dlvF1, ['f1']);
        await holder.query('ROLLBACK');
        committed = await until(async () => (await entry(IDS.dlvF1, 'f1')).reward_status === 2, 10000);
    } finally {
        await holder.query('ROLLBACK');
        holder.release();
    }
    const at = (await entry(IDS.dlvF1, 'f1')).delivered_at;
    await sleep(20);
    const retry = await ack(IDS.dlvF1, ['f1']);
    check('R10 락 대기로 ack 2005 → 잠금 해제 후 실제 반영, 재시도는 성공·delivered_at 그대로', lost.result === 2005 && committed >= 0 && retry.result === 0 && notApplied(retry) === ''
        && (await entry(IDS.dlvF1, 'f1')).delivered_at.getTime() === at.getTime(), `(${lost.result}, ${committed}ms, ${retry.result})`);

    // 데드락: holder가 f3(과 F2 전체)을 잡고, ack [f2, f3]이 f2를 잡은 채 f3을 기다릴 때 holder가 f2를 요청한다.
    // InnoDB는 잠금이 적은 쪽(ack SP)을 희생시킨다 → SP EXIT HANDLER 50001 → 500. 재시도하면 반영된다.
    const h2 = await M.getConnection();
    let deadlocked;
    let holderErr = null;
    try {
        await h2.query('START TRANSACTION');
        await h2.query('SELECT member_id FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 FOR UPDATE', [IDS.dlvF2]);
        await h2.query("SELECT member_id FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = 'f3' FOR UPDATE", [IDS.dlvF1]);
        const pendingAck = ack(IDS.dlvF1, ['f2', 'f3']);
        await sleep(500);
        try {
            await h2.query("SELECT member_id FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = 'f2' FOR UPDATE", [IDS.dlvF1]);
        } catch (e) {
            holderErr = e.errno;
        }
        deadlocked = await pendingAck;
    } finally {
        await h2.query('ROLLBACK');
        h2.release();
    }
    const after = [(await entry(IDS.dlvF1, 'f2')).reward_status, (await entry(IDS.dlvF1, 'f3')).reward_status];
    const again = await ack(IDS.dlvF1, ['f2', 'f3']);
    check('R11 ack 데드락 → 50001(500)·반영 없음(롤백), 재시도 성공', deadlocked.result === 50001 && holderErr === null && after.join() === '1,1'
        && again.result === 0 && notApplied(again) === '', `(${deadlocked.result}, holder ${holderErr}, ${after})`);

    // 워커 실제 로그: 1초 정체, 적체 > 1, 0.5초 주기. F1 남은 f4, F2 남은 5명
    const [{ others }] = await q('SELECT COUNT(season_no) others FROM ranking_season WHERE status = 7 AND ranking_id NOT IN (?)', [[IDS.dlvF1, IDS.dlvF2]]);
    const base = (text) => logCount('t10', text);
    const b0 = ['reward ack stalled ranking=' + IDS.dlvF1, 'reward ack stalled ranking=' + IDS.dlvF2, 'DELIVERING backlog:', 'rewards delivered ranking=' + IDS.dlvF1, 'reward ack resumed ranking=' + IDS.dlvF2, 'DELIVERING backlog cleared'].map(base);
    const grew = (i, text) => base(text) > b0[i];
    startWorker('t10', { DELIVERY_STALL_SEC: '1', DELIVERY_BACKLOG_MAX: '1', DELIVERY_INTERVAL_MS: '500' });
    const warned = await until(async () => grew(0, 'reward ack stalled ranking=' + IDS.dlvF1) && grew(1, 'reward ack stalled ranking=' + IDS.dlvF2) && grew(2, 'DELIVERING backlog:'), 20000);
    await ack(IDS.dlvF1, ['f4']);
    await ack(IDS.dlvF2, ['f0']);
    const cleared = await until(async () => grew(3, 'rewards delivered ranking=' + IDS.dlvF1) && grew(4, 'reward ack resumed ranking=' + IDS.dlvF2)
        && (others > 0 || grew(5, 'DELIVERING backlog cleared')), 20000);
    const [{ status }] = await q('SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.dlvF1]);
    check('R12 워커 로그: 두 시즌 ack 정체·적체 경고 → ack 후 F1 SETTLED, F2 재개, 적체 해소', warned >= 0 && cleared >= 0 && status === 8,
        `(${warned}ms, ${cleared}ms, 다른 DELIVERING ${others})`);
}

// ------------------------------------------------------------------------------------------------ 6. 로그 정리 (01_DESIGN 4.5, 11.4)

/** UTC 오늘에서 days일 떨어진 날짜 'YYYY-MM-DD' */
const utcDay = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** 날짜의 일 파티션 이름 */
const dayPart = (day) => `p_${day.replaceAll('-', '')}`;

/**
 * 로그 DB 제출 이력의 일 파티션 이름 (p_max 제외, 순서대로)
 * @returns 파티션 이름 목록
 */
async function logDayParts() {
    return (await LM.query("SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME <> 'p_max' ORDER BY PARTITION_ORDINAL_POSITION"))[0].map((x) => x.n);
}

/**
 * 테스트 제출 이력 한 줄을 로그 DB에 직접 넣는다.
 * @param requestId 요청 ID (지울 때 찾는 값)
 * @param day 기록 날짜 'YYYY-MM-DD'
 * @returns 없음
 */
async function insertLogRow(requestId, day) {
    await LM.query(`INSERT INTO log_ranking_submit (created_at, ranking_id, season_no, request_id, member_id, input_value, result_code)
                    VALUES (?, ?, 1, ?, 'm1', 1, 0)`, [`${day} 12:00:00`, IDS.broken, requestId]);
}

/**
 * 로그 DB의 월 테이블 이름 목록 (log_ranking_submit_YYYYMM)
 * @returns 테이블 이름 목록
 */
async function logMonthTables() {
    return (await LM.query("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME REGEXP '^log_ranking_submit_[0-9]{6}$' ORDER BY n"))[0].map((x) => x.n);
}

/**
 * 맨 앞 일 파티션에서 지난 날짜의 일 파티션들을 떼어 만든다 (오래된 것부터 차례로 생긴 상태)
 * @param days 만들 날짜 'YYYY-MM-DD' 목록 (오름차순, 하루씩 이어짐)
 * @returns 없음
 */
async function splitOldDays(days) {
    const [first] = await logDayParts();
    const [[{ d }]] = await LM.query("SELECT PARTITION_DESCRIPTION d FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit' AND PARTITION_NAME = ?", [first]);
    const next = new Date(Date.parse(days.at(-1)) + 86_400_000).toISOString().slice(0, 10);
    await LM.query(`ALTER TABLE log_ranking_submit REORGANIZE PARTITION \`${first}\` INTO (`
        + days.map((day, i) => `PARTITION \`${dayPart(day)}\` VALUES LESS THAN ('${days[i + 1] ?? next} 00:00:00'), `).join('')
        + `PARTITION \`${first}\` VALUES LESS THAN (${d}))`);
}

/**
 * 월 테이블의 한 날짜 파티션에서 요청 ID로 행 수를 센다.
 * @param day 날짜 'YYYY-MM-DD'
 * @param requestId 요청 ID
 * @returns 행 수
 */
async function monthRows(day, requestId) {
    const [[{ n }]] = await LM.query(`SELECT COUNT(log_ranking_submit_id) n FROM \`log_ranking_submit_${day.slice(0, 7).replace('-', '')}\` PARTITION (\`${dayPart(day)}\`) WHERE request_id = ?`, [requestId]);
    return Number(n);
}

/**
 * 로그 정리 잡: 오늘 + 7일까지 빈틈없이 생성, 보관 기간이 지난 파티션을 월 테이블로 이동(중단 후 이어서 포함), 오래된 월 테이블 삭제,
 * p_max 행 감지, 워커가 job_state를 남김.
 * 개발 로그 DB의 실제 파티션에 하는 일이다 — 보관 90일이라 최근 파티션과 행은 건드리지 않는다. 테스트가 만든 월 테이블은 끝에 지운다.
 * @returns 없음
 */
async function logCleanupScenarios() {
    const monthAgo = (n) => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - n); return `log_ranking_submit_${t.toISOString().slice(0, 7).replace('-', '')}`; };
    const [m13, m12] = [monthAgo(13), monthAgo(12)];
    // 테스트가 쓰는 월 테이블(90일 넘은 날짜의 달, 12·13개월 전)과 교환 테이블. 중단된 이전 실행이 남긴 것도 지운다 — 개발 로그 DB 전용이다
    const testTables = [...new Set([-100, -99, -98].map((d) => `log_ranking_submit_${utcDay(d).slice(0, 7).replace('-', '')}`)), m13, m12, 'log_ranking_submit_xchg'];
    const dropTestTables = async () => { for (const t of testTables) await LM.query(`DROP TABLE IF EXISTS \`${t}\``); };
    await dropTestTables();
    await cleanupLogPartitions(LA, 90, 12);
    const parts = await logDayParts();
    const days = parts.map((n) => Date.UTC(+n.slice(2, 6), +n.slice(6, 8) - 1, +n.slice(8, 10)));
    check('L1 오늘 + 7일까지 일 파티션, 하루씩 빈틈없음', parts.includes(dayPart(utcDay(0))) && parts.at(-1) === dayPart(utcDay(7))
        && days.every((d, i) => i === 0 || d - days[i - 1] === 86_400_000), `(${parts[0]}..${parts.at(-1)}, ${parts.length}개)`);
    const again = await cleanupLogPartitions(LA, 90, 12);
    check('L2 다시 돌면 할 일 없음', again.added === 0 && again.archived === 0 && again.droppedMonths === 0 && !again.pmaxHadRows, JSON.stringify(again));

    // 보관 기간이 지난 파티션 두 개(하나는 행 있음, 하나는 빈 날)를 월 테이블로 옮긴다
    const old = [utcDay(-100), utcDay(-99)];
    await splitOldDays(old);
    await insertLogRow('rt-log-old', old[0]);
    await insertLogRow('rt-log-today', utcDay(0));
    const moved = await cleanupLogPartitions(LA, 90, 12);
    const left = await logDayParts();
    const [[{ oldRows, todayRows }]] = await LM.query("SELECT SUM(request_id = 'rt-log-old') oldRows, SUM(request_id = 'rt-log-today') todayRows FROM log_ranking_submit WHERE ranking_id = ?", [IDS.broken]);
    const archivedOld = await monthRows(old[0], 'rt-log-old');
    const xchgLeft = (await LM.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit_xchg'"))[0].length;
    check('L3 보관 기간(90일)이 지난 파티션만 월 테이블의 같은 날 파티션으로 이동, 운영 테이블에서는 빠지고 오늘 행은 남음, 교환 테이블 없음',
        moved.archived === 2 && !left.some((n) => old.map(dayPart).includes(n)) && left.includes(dayPart(utcDay(0)))
        && Number(oldRows ?? 0) === 0 && Number(todayRows) === 1 && archivedOld === 1 && xchgLeft === 0,
        `(archived ${moved.archived}, 운영 old ${oldRows}, 월 테이블 old ${archivedOld}, today ${todayRows}, xchg ${xchgLeft})`);

    // 첫 교환(운영 → 교환 테이블) 직후 끊긴 상태를 만든다. 다음 실행이 월 테이블 교환부터 이어서 해야 한다
    const cut = utcDay(-98);
    await splitOldDays([cut]);
    await insertLogRow('rt-log-cut', cut);
    await LM.query('CREATE TABLE log_ranking_submit_xchg LIKE log_ranking_submit');
    await LM.query('ALTER TABLE log_ranking_submit_xchg REMOVE PARTITIONING');
    await LM.query(`ALTER TABLE log_ranking_submit EXCHANGE PARTITION \`${dayPart(cut)}\` WITH TABLE log_ranking_submit_xchg`);
    const resumed = await cleanupLogPartitions(LA, 90, 12);
    const cutLeft = (await logDayParts()).includes(dayPart(cut));
    const cutXchg = (await LM.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_ranking_submit_xchg'"))[0].length;
    const cutArchived = await monthRows(cut, 'rt-log-cut');
    check('L3b 첫 교환 뒤 끊긴 이동은 다음 실행이 이어서 끝냄 (월 테이블에 1행, 운영 파티션·교환 테이블 없음)',
        resumed.archived === 1 && cutArchived === 1 && !cutLeft && cutXchg === 0, `(archived ${resumed.archived}, 월 테이블 ${cutArchived}, 운영 파티션 ${cutLeft}, xchg ${cutXchg})`);

    // 월 테이블 보관 12개월: 끝난 지 12개월이 지난 달(13개월 전)은 지우고, 12개월 전 달은 남긴다
    for (const t of [m13, m12])
        await LM.query(`CREATE TABLE IF NOT EXISTS \`${t}\` LIKE log_ranking_submit`);
    const expired = await cleanupLogPartitions(LA, 90, 12);
    const monthsNow = await logMonthTables();
    check('L3c 보관 12개월이 지난 월 테이블만 삭제 (13개월 전 삭제, 12개월 전 남음)',
        expired.droppedMonths === 1 && !monthsNow.includes(m13) && monthsNow.includes(m12), `(dropped ${expired.droppedMonths}, ${monthsNow.join(', ')})`);

    // 파티션이 없는 날의 행은 p_max로 간다 — 그날 파티션을 제때 만들지 못한 상태
    await insertLogRow('rt-log-pmax', utcDay(30));
    const warned = await cleanupLogPartitions(LA, 90, 12);
    await LM.query("DELETE FROM log_ranking_submit WHERE request_id = 'rt-log-pmax'");
    const clear = await cleanupLogPartitions(LA, 90, 12);
    check('L4 p_max에 행이 있으면 알림 값, 없어지면 해제', warned.pmaxHadRows && !clear.pmaxHadRows);

    // 보관 0일·0개월은 옮기자마자(지우자마자) 되돌릴 수 없으므로 SP가 거부한다. 미리 만들기는 31일까지만
    const before = await logDayParts();
    const zero = await callSp(LA, 'SP_LOG_PARTITION_ARCHIVE', [0]);
    const zeroMonths = await callSp(LA, 'SP_LOG_ARCHIVE_DROP', [0]);
    const over = await callSp(LA, 'SP_LOG_PARTITION_ADD', [32]);
    check('L4b 보관 0일·월 보관 0개월·미리 만들기 32일은 1001, 파티션·월 테이블 그대로',
        zero.result === 1001 && zeroMonths.result === 1001 && over.result === 1001
        && JSON.stringify(await logDayParts()) === JSON.stringify(before) && (await logMonthTables()).includes(m12),
        `(${zero.result}, ${zeroMonths.result}, ${over.result})`);

    await dropTestTables();

    await q("DELETE FROM job_state WHERE job_name = 'log_cleanup'");
    startWorker('tL');
    const recorded = await until(async () => (await q("SELECT job_name FROM job_state WHERE job_name = 'log_cleanup'")).length === 1, 15000);
    check('L5 워커가 로그 정리 후 job_state(log_cleanup) 기록', recorded >= 0);

    // 정체 감시: 마지막 성공이 3시간 넘으면 정체, 기록이 없으면 프로세스 가동 3시간 뒤부터 정체
    const fresh = await checkJobStall(A, 'log_cleanup');
    await q("UPDATE job_state SET last_run_at = UTC_TIMESTAMP(3) - INTERVAL 4 HOUR WHERE job_name = 'log_cleanup'");
    const stale = await checkJobStall(A, 'log_cleanup');
    await q("DELETE FROM job_state WHERE job_name = 'log_cleanup'");
    const neverEarly = await checkJobStall(A, 'log_cleanup', 60);
    const neverLate = await checkJobStall(A, 'log_cleanup', 4 * 3600);
    check('L6 정체 감시: 방금 성공은 정상, 4시간 전이면 정체, 기록 없음은 가동 3시간 뒤부터 정체',
        !fresh.stalled && stale.stalled && stale.ageSec >= 4 * 3600 && !neverEarly.stalled && neverLate.stalled && neverLate.ageSec === null,
        JSON.stringify({ fresh, stale, neverEarly, neverLate }));
}

// ------------------------------------------------------------------------------------------------ 7. 시즌 백업 분리 (01_DESIGN 8.2, 8.3)

/**
 * 운영 테이블의 시즌 파티션 존재 여부
 * @param table 'ranking_entry' | 'ranking_submit_key'
 * @param id 랭킹 ID
 * @param no 시즌 번호
 * @returns 있으면 true
 */
async function hasSeasonPart(table, id, no) {
    return (await q('SELECT 1 FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME = ?', [table, `p_r${id}_s${no}`])).length === 1;
}

/**
 * 백업 테이블의 행 수 (없으면 -1)
 * @param table 백업 테이블 이름
 * @returns 행 수
 */
async function backupRows(table) {
    if (!(await q('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).length)
        return -1;
    return Number((await q(`SELECT COUNT(member_id) n FROM \`${table}\``))[0].n);
}

/**
 * 백업 분리 잡: SETTLED 시즌 파티션을 백업 테이블로 옮기고 빈 파티션을 지움, entry는 다음 시즌 SETTLED까지 기다림(D-52),
 * 재실행 무변화(되돌아가지 않음), 백업 COMMENT, 보관 기간이 지난 백업 경고 대상(0일은 제외), 워커가 job_state를 남김.
 * @returns 없음
 */
async function archiveScenarios() {
    const { arc: id, arcLast: last } = IDS;
    const day = 86_400;
    // 반복 랭킹(FIXED): 시즌 1·2 SETTLED, 3 DELIVERING. 시즌 1은 45일 전에 끝나 보관 30일이 지났다
    await createDefinition(id, { cycleType: 4, cycleValue: 3600, startSec: -50 * day });
    await createSeason(id, 1, -50 * day, -45 * day, 8);
    await createSeason(id, 2, -45 * day, -day, 8);
    await createSeason(id, 3, -day, 3600, 7);
    // 반복 없는 랭킹의 시즌 1: 다음 시즌이 생기지 않으므로 자기 시즌 SETTLED만으로 entry도 분리한다
    await createDefinition(last, { startSec: -3 * day });
    await createSeason(last, 1, -3 * day, -2 * day, 8);
    for (const [rid, no] of [[id, 1], [id, 2], [id, 3], [last, 1]]) {
        await q('INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at) VALUES (?, ?, ?, 1, NOW(3), 1, NOW(3))', [rid, no, `a${no}`]);
        await q('INSERT INTO ranking_submit_key (ranking_id, season_no, request_id, member_id, input_value, rejected, created_at) VALUES (?, ?, ?, ?, 1, NULL, NOW(3))', [rid, no, `arc-${rid}-${no}`, `a${no}`]);
    }

    const r1 = await runArchive(A);
    const parts = {
        s1: await hasSeasonPart('ranking_entry', id, 1) || await hasSeasonPart('ranking_submit_key', id, 1),
        s2Entry: await hasSeasonPart('ranking_entry', id, 2), s2Key: await hasSeasonPart('ranking_submit_key', id, 2),
        s3: await hasSeasonPart('ranking_entry', id, 3) && await hasSeasonPart('ranking_submit_key', id, 3),
        last: await hasSeasonPart('ranking_entry', last, 1) || await hasSeasonPart('ranking_submit_key', last, 1),
    };
    const rows = {
        e1: await backupRows(`ranking_entry_r${id}_s1`), k1: await backupRows(`ranking_submit_key_r${id}_s1`),
        e2: await backupRows(`ranking_entry_r${id}_s2`), k2: await backupRows(`ranking_submit_key_r${id}_s2`),
        eL: await backupRows(`ranking_entry_r${last}_s1`), kL: await backupRows(`ranking_submit_key_r${last}_s1`),
    };
    check('B1 SETTLED 시즌을 백업 테이블로 분리·빈 파티션 삭제: submit_key는 바로, entry는 다음 시즌 SETTLED(또는 마지막 시즌)일 때만',
        r1.exchanged === 5 && r1.dropped === 5 && r1.waiting === 1 && !parts.s1 && parts.s2Entry && !parts.s2Key && parts.s3 && !parts.last
        && rows.e1 === 1 && rows.k1 === 1 && rows.e2 === -1 && rows.k2 === 1 && rows.eL === 1 && rows.kL === 1,
        JSON.stringify({ ...r1, expired: r1.expired.length, parts, rows }));

    const [{ c }] = await q('SELECT TABLE_COMMENT c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [`ranking_entry_r${id}_s1`]);
    check('B2 백업 COMMENT에 랭킹 코드·시즌 기간', c.includes(`RT${id}`) && c.includes('season 1') && c.includes('UTC'), `(${c})`);

    const names = r1.expired.map((b) => b.tableName);
    const msg = expiredMessage(r1.expired);
    check('B3 보관 기간(30일)이 지난 백업만 경고 대상, 문구에 코드·종료일',
        names.length === 2 && names.includes(`ranking_entry_r${id}_s1`) && names.includes(`ranking_submit_key_r${id}_s1`) && msg.includes(`RT${id}`) && msg.includes('ended '),
        `(${msg})`);

    const r2 = await runArchive(A);
    check('B4 다시 돌면 할 일 없음, 백업 데이터는 되돌아가지 않음', r2.exchanged === 0 && r2.dropped === 0 && r2.waiting === 1
        && await backupRows(`ranking_entry_r${id}_s1`) === 1 && await backupRows(`ranking_submit_key_r${id}_s2`) === 1, JSON.stringify({ ...r2, expired: r2.expired.length }));

    await q('UPDATE ranking_season SET status = 8 WHERE ranking_id = ? AND season_no = 3', [id]);
    const r3 = await runArchive(A);
    check('B5 다음 시즌이 SETTLED가 되면 기다리던 entry도 분리 (시즌 3 entry는 다음 시즌 행이 없어 기다림)',
        r3.exchanged === 2 && r3.waiting === 1 && !await hasSeasonPart('ranking_entry', id, 2) && await backupRows(`ranking_entry_r${id}_s2`) === 1
        && await hasSeasonPart('ranking_entry', id, 3) && !await hasSeasonPart('ranking_submit_key', id, 3), JSON.stringify({ ...r3, expired: r3.expired.length }));

    await q('UPDATE ranking_definition SET history_retention = 0 WHERE ranking_id = ?', [id]);
    const r4 = await runArchive(A);
    check('B6 history_retention 0(무기한)은 경고 대상 아님', r4.expired.length === 0, `(${r4.expired.length})`);

    await q("DELETE FROM job_state WHERE job_name = 'archive'");
    startWorker('tA');
    const recorded = await until(async () => (await q("SELECT job_name FROM job_state WHERE job_name = 'archive'")).length === 1, 15000);
    const watch = await checkJobStall(A, 'archive');
    check('B7 워커가 백업 분리 후 job_state(archive) 기록, 정체 아님', recorded >= 0 && !watch.stalled, JSON.stringify(watch));
}

// ------------------------------------------------------------------------------------------------ 8. 장애 주입

/** 닿지 않는 주소 (연결 즉시 거부). Redis·로그 DB·메인 DB 장애를 프로세스 단위로 만든다 */
const DEAD_PORT = '1';

/**
 * 인스턴스를 띄우고 스스로 종료하기를 기다린다 (기동 거부 확인용, spawnTracked와 달리 종료를 FAIL로 보지 않는다).
 * @param kind 'api' | 'worker'
 * @param id 인스턴스 ID
 * @param env 추가 환경 변수
 * @param ms 제한 시간
 * @returns 종료 코드 (시간 안에 끝나지 않으면 강제 종료하고 null)
 */
async function runUntilExit(kind, id, env, ms = 20000) {
    const p = spawn(process.execPath, [`dist/${kind}.js`], { stdio: 'ignore', env: { ...process.env, INSTANCE_ID: id, ...env } });
    return await new Promise((ok) => {
        const t = setTimeout(() => {
            p.kill();
            ok(null);
        }, ms);
        p.on('exit', (code) => {
            clearTimeout(t);
            ok(code);
        });
    });
}

/**
 * API 장애 주입: 요청 형식 오류·권한·상태 거부, 빈도 초과, 같은 requestId 동시 제출, 락 대기로 응답 시간 초과(2005) 뒤 커밋,
 * Redis·로그 DB가 죽은 API, 메인 DB에 닿지 않는 API·워커의 기동 거부, 실행 중 migrate 거부.
 * X11~X20: 조회·보상 API 검증, 같은 멤버 동시 첫 제출, API 경유 1205 롤백, TCP 프록시(tcpProxy)로 만든 실행 중 Redis 무응답·다운,
 * 로그 DB·메인 DB 다운 → 복구, 제출 처리 중 API 강제 종료, 잘못된 설정·포트 충돌 기동 거부, 키 폐기 전파(30초).
 * X21~X22: 제출 경로 데드락, 메인 DB 무응답 중 동시 제출(풀 대기열 상한·호출 제한 시간).
 * 포트: TEST_PORT ~ TEST_PORT+5.
 * @returns 없음
 */
async function apiFaults() {
    await createRanking(IDS.fxSum, 2);
    await createRanking(IDS.fxRate, 1);
    await createRanking(IDS.fxPaused, 1);
    await q('UPDATE ranking_definition SET max_submit_per_min = 3 WHERE ranking_id = ?', [IDS.fxRate]);
    await q('UPDATE ranking_definition SET status = 2 WHERE ranking_id = ?', [IDS.fxPaused]);
    const mk = async (name, scopes) => {
        const key = randomBytes(32).toString('base64url');
        await callSp(M, 'SP_INSERT_API_CREDENTIAL', [name, hashApiKey(key), scopes]);
        return key;
    };
    const writeKey = await mk('rtest-write', ApiScope.WRITE);
    const readKey = await mk('rtest-read', ApiScope.READ);
    // API가 랭킹 정의와 키 목록을 기동 때 읽으므로(D-56, 10.1) 픽스처·키는 API보다 먼저 만든다
    await createRanking(IDS.fxBest, 1);
    const rewardKey = await mk('rtest-reward', ApiScope.REWARD);
    const revokeKey = await mk('rtest-revoke', ApiScope.READ);
    // 실행 중 장애용 프록시: t11·tx12의 Redis, tx12의 메인·로그 DB가 이 프록시를 거친다
    const redisUrl = new URL(config.redis.url);
    const redisProxy = await tcpProxy(redisUrl.hostname, Number(redisUrl.port || 6379));
    const dbProxy = await tcpProxy(config.db.host, config.db.port);
    const logProxy = await tcpProxy(config.logDb.host, config.logDb.port);
    redisUrl.hostname = '127.0.0.1';
    redisUrl.port = String(redisProxy.port);
    startWorker('t11', { REDIS_URL: redisUrl.href });
    // tx1: 정상 API (처리 제한 2초). tx2: Redis·로그 DB가 모두 죽은 API. tx13: 강제 종료용
    // tx12: 프록시 경유 API. 처리 제한 15초·DB 호출 제한 7초 — 락 대기 5초(1205)를 50001로 받고, DB 무응답은 7초에 끊는다
    spawnTracked('tx1', 'api', { API_PORT: String(PORT), API_TIMEOUT_MS: '2000' });
    spawnTracked('tx2', 'api', { API_PORT: String(PORT + 1), REDIS_URL: `redis://127.0.0.1:${DEAD_PORT}`, DB_LOG_PORT: DEAD_PORT });
    spawnTracked('tx12', 'api', {
        API_PORT: String(PORT + 3), REDIS_URL: redisUrl.href, DB_HOST: '127.0.0.1', DB_PORT: String(dbProxy.port), DB_LOG_HOST: '127.0.0.1', DB_LOG_PORT: String(logProxy.port),
        API_TIMEOUT_MS: '15000', DB_QUERY_TIMEOUT_MS: '7000',
    });
    spawnTracked('tx13', 'api', { API_PORT: String(PORT + 4) });
    const DOWN = `http://localhost:${PORT + 1}`;
    const PROXIED = `http://localhost:${PORT + 3}`;
    const DOOMED = `http://localhost:${PORT + 4}`;
    const raw = async (base, path, { key = writeKey, method = 'POST', body } = {}) => {
        const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body });
        return { status: res.status, ...(await res.json()) };
    };
    const post = (id, b, base = BASE) => raw(base, `/v1/rankings/${id}/scores`, { body: JSON.stringify(b) });
    const get = (path, base = BASE) => raw(base, path, { key: readKey, method: 'GET' });
    const up = await until(async () => {
        try {
            return (await get('/health')).result === 0 && (await get('/health', DOWN)).result === 0 && (await get('/health', DOOMED)).result === 0
                && (await get(`/v1/rankings/${IDS.fxSum}/top?size=1`)).result === 0 && (await get(`/v1/rankings/${IDS.fxSum}/top?size=1`, PROXIED)).result === 0
                && (await get(`/v1/rankings/${IDS.fxBest}/top?size=1`)).result === 0;
        } catch {
            return false; // 기동 전 연결 거부
        }
    }, 30000);
    check('X0 정상 API·장애 API(Redis·로그 DB 없음) 모두 기동, 순위표 준비', up >= 0, `(${up}ms)`);

    // 키 폐기: API는 키 목록을 30초마다 다시 읽는다(10.1). 여기서 폐기하고 구간 끝(X20)에서 2002로 바뀌었는지 본다
    const revokePath = `/v1/rankings/${IDS.fxSum}/top?size=1`;
    const beforeRevoke = await raw(BASE, revokePath, { key: revokeKey, method: 'GET' });
    const [{ api_credential_id: revokeId }] = await q("SELECT api_credential_id FROM api_credential WHERE key_name = 'rtest-revoke'");
    const revoked = await callSp(M, 'SP_REVOKE_API_CREDENTIAL', [revokeId]);
    const revokedAt = Date.now();
    const rightAfter = await raw(BASE, revokePath, { key: revokeKey, method: 'GET' });
    // 구간이 30초보다 길 수 있어 2002가 처음 나온 시각을 따로 잰다 (0.5초 간격, 최대 40초)
    let revokeSeenMs = -1;
    const revokePoll = (async () => {
        while (revokeSeenMs < 0 && Date.now() - revokedAt < 40000) {
            try {
                if ((await raw(BASE, revokePath, { key: revokeKey, method: 'GET' })).result === 2002)
                    revokeSeenMs = Date.now() - revokedAt;
            } catch {
                // 판정은 끝에서 한다
            }
            await sleep(500);
        }
    })();

    // 형식·권한·상태 거부: 결과 코드와 HTTP 상태가 함께 맞아야 한다
    const tag = `fx-${Date.now()}`;
    const ok = (o) => ({ memberId: tag, value: 1, seasonNo: 1, requestId: `${tag}-${++seq}`, ...o });
    const cases = [
        ['깨진 JSON', await raw(BASE, `/v1/rankings/${IDS.fxSum}/scores`, { body: '{"memberId":' }), 2001, 400],
        ['필수 필드 없음', await post(IDS.fxSum, { memberId: tag, value: 1 }), 2001, 400],
        ['memberId 65자', await post(IDS.fxSum, ok({ memberId: 'x'.repeat(65) })), 2001, 400],
        ['바디 16KB 초과', await post(IDS.fxSum, ok({ meta: { pad: 'x'.repeat(17000) } })), 2001, 400],
        ['값 타입 오류', await post(IDS.fxSum, ok({ value: 'ten' })), 2001, 400],
        // 바디는 타입 변환을 하지 않는다: 숫자 문자열·숫자 memberId도 거부
        ['값 숫자 문자열', await post(IDS.fxSum, ok({ value: '10' })), 2001, 400],
        ['memberId 숫자', await post(IDS.fxSum, ok({ memberId: 123 })), 2001, 400],
        ['seasonNo 숫자 문자열', await post(IDS.fxSum, ok({ seasonNo: '1' })), 2001, 400],
        ['없는 경로', await raw(BASE, '/v1/nothing', { method: 'GET' }), 2004, 404],
        ['키 없음', await raw(BASE, `/v1/rankings/${IDS.fxSum}/scores`, { key: null, body: JSON.stringify(ok()) }), 2002, 401],
        ['위조 키', await raw(BASE, `/v1/rankings/${IDS.fxSum}/scores`, { key: randomBytes(32).toString('base64url'), body: JSON.stringify(ok()) }), 2002, 401],
        ['read 키로 제출', await raw(BASE, `/v1/rankings/${IDS.fxSum}/scores`, { key: readKey, body: JSON.stringify(ok()) }), 2003, 403],
        ['없는 랭킹', await post(99999, ok()), 1101, 404],
        ['중지된 랭킹', await post(IDS.fxPaused, ok()), 1102, 409],
        ['지난 시즌 번호', await post(IDS.fxSum, ok({ seasonNo: 2 })), 1103, 409],
        ['BEST 음수', await post(IDS.fxRate, ok({ memberId: `${tag}-neg`, value: -1 })), 1105, 400],
        ['SUM 상한 초과', await post(IDS.fxSum, ok({ value: 9000 })), 1107, 400],
    ];
    const wrong = cases.filter(([, r, code, http]) => r.result !== code || r.status !== http);
    check(`X1 형식·권한·상태 거부 ${cases.length}종: 결과 코드와 HTTP 상태`, wrong.length === 0, wrong.map(([n, r]) => `${n}=${r.result}/${r.status}`).join(', '));

    // 빈도 초과: 분당 3회. 4번째는 2006/429, 다른 멤버는 영향 없음
    const rate = [];
    for (let i = 0; i < 4; i++)
        rate.push(await post(IDS.fxRate, ok({ value: 10 + i })));
    const other = await post(IDS.fxRate, ok({ memberId: `${tag}-other`, value: 5 }));
    check('X2 빈도 초과: 같은 멤버 4번째 2006/429, 다른 멤버는 성공', rate.slice(0, 3).every((r) => r.result === 0) && rate[3].result === 2006 && rate[3].status === 429 && other.result === 0,
        `(${rate.map((r) => r.result)}, ${other.result})`);

    // 같은 requestId 10개 동시 (SUM +5): 한 번만 반영, 나머지는 재전송. 같은 키로 다른 값은 1104
    const same = ok({ memberId: `${tag}-dup`, value: 5 });
    const burst = await Promise.all(Array.from({ length: 10 }, () => post(IDS.fxSum, same)));
    const conflict = await post(IDS.fxSum, { ...same, value: 6 });
    const firsts = burst.filter((r) => r.result === 0 && r.data.replayed === false).length;
    check('X3 같은 requestId 동시 10개: 1개만 반영·9개 재전송, 점수 5 / 같은 키 다른 값 1104', burst.every((r) => r.result === 0 && r.data.score === 5) && firsts === 1 && conflict.result === 1104,
        `(첫 반영 ${firsts}, ${burst.map((r) => r.result)}, ${conflict.result})`);

    // 다른 세션이 멤버 행을 잠근 동안 제출 → 2초에 2005, 잠금이 풀리면 SP가 커밋. 같은 requestId 재시도는 재전송으로 한 번만 반영
    const lockMember = `${tag}-lock`;
    await post(IDS.fxSum, ok({ memberId: lockMember, value: 10 }));
    const holder = await M.getConnection();
    try {
        await holder.query('START TRANSACTION');
        await holder.query('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ? FOR UPDATE', [IDS.fxSum, lockMember]);
        const late = ok({ memberId: lockMember, value: 7 });
        const t = Date.now();
        const timedOut = await post(IDS.fxSum, late);
        const waited = Date.now() - t;
        await holder.query('ROLLBACK');
        const applied = await until(async () => (await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, lockMember]))[0].score === 17, 10000);
        const retry = await post(IDS.fxSum, late);
        check('X4 락 대기로 제출 2005(2초) → 잠금 해제 후 실제 반영(17), 같은 requestId 재시도는 replayed·점수 그대로', timedOut.result === 2005 && timedOut.status === 503
            && waited < 4000 && applied >= 0 && retry.result === 0 && retry.data.replayed === true && retry.data.score === 17, `(${timedOut.result}, ${waited}ms, ${applied}ms, ${retry.data?.score})`);
    } finally {
        await holder.query('ROLLBACK');
        holder.release();
    }

    // Redis·로그 DB가 죽은 API: 제출은 원장에 성공, 조회는 2007, 빈도 검사는 통과로 동작. 워커가 순위표를 채운다
    const downMember = `${tag}-down`;
    const downSubmit = await post(IDS.fxSum, ok({ memberId: downMember, value: 3 }), DOWN);
    const downRead = await get(`/v1/rankings/${IDS.fxSum}/members/${downMember}`, DOWN);
    const downRate = [];
    for (let i = 0; i < 5; i++)
        downRate.push((await post(IDS.fxRate, ok({ memberId: `${tag}-rd`, value: 20 + i }), DOWN)).result);
    const filled = await until(async () => (await get(`/v1/rankings/${IDS.fxSum}/members/${downMember}`)).data?.score === 3, 15000);
    const logWarn = await until(async () => logCount('tx2', 'submit log write failed', 'api') > 0, 10000);
    const [[{ n: logRows }]] = await LM.query('SELECT COUNT(log_ranking_submit_id) n FROM log_ranking_submit WHERE ranking_id = ? AND member_id = ?', [IDS.fxSum, downMember]);
    check('X5 Redis·로그 DB 장애 API: 제출 성공·조회 2007·빈도 검사 통과(5회), 워커가 순위표 채움, 이력 기록 실패 경고(로그 DB 행 없음)',
        downSubmit.result === 0 && downRead.result === 2007 && downRead.status === 503 && downRate.every((r) => r === 0) && filled >= 0 && logWarn >= 0 && logRows === 0
        && logCount('tx2', 'unreachable', 'api') > 0, `(${downSubmit.result}, ${downRead.result}, ${downRate}, ${filled}ms, 로그 DB ${logRows}행)`);

    // 조회·보상 API의 쿼리·경로·바디 검증 (X1은 제출만 본다)
    const rewardBase = `/v1/rankings/${IDS.fxSum}/seasons/1/rewards`;
    const qcases = [
        ['top size=0', await get(`/v1/rankings/${IDS.fxSum}/top?size=0`)],
        ['top size 상한 초과', await get(`/v1/rankings/${IDS.fxSum}/top?size=1000000`)],
        ['top size 문자', await get(`/v1/rankings/${IDS.fxSum}/top?size=x`)],
        ['랭킹 ID 0', await get('/v1/rankings/0/top')],
        ['시즌 번호 0', await get(`/v1/rankings/${IDS.fxSum}/seasons/0/results`)],
        ['results offset 음수', await get(`/v1/rankings/${IDS.fxSum}/seasons/1/results?offset=-1`)],
        ['rewards cursor 65자', await raw(BASE, `${rewardBase}?cursor=${'c'.repeat(65)}`, { key: rewardKey, method: 'GET' })],
        ['ack 빈 배열', await raw(BASE, `${rewardBase}/ack`, { key: rewardKey, body: JSON.stringify({ memberIds: [] }) })],
        // 바디는 타입 변환을 하지 않으므로 문자열 하나를 1개짜리 배열로 바꿔 받지 않는다
        ['ack memberIds 문자열', await raw(BASE, `${rewardBase}/ack`, { key: rewardKey, body: JSON.stringify({ memberIds: 'f0' }) })],
    ];
    const qwrong = qcases.filter(([, r]) => r.result !== 2001 || r.status !== 400);
    check(`X11 조회·보상 API 쿼리·경로·바디 검증 ${qcases.length}종: 2001/400`, qwrong.length === 0, qwrong.map(([n, r]) => `${n}=${r.result}/${r.status}`).join(', '));

    // 같은 멤버의 첫 제출이 서로 다른 requestId로 20개 동시: SUM은 SP의 txn 재시도(1062) 경로를 지나 20번 모두 반영(유실 없음),
    // BEST는 최고값만 남는다. 원장·Redis를 모두 확인한다
    const race = `${tag}-race`;
    const sumRace = await Promise.all(Array.from({ length: 20 }, () => post(IDS.fxSum, ok({ memberId: race, value: 1 }))));
    const bestValues = Array.from({ length: 20 }, (_, i) => (i + 1) * 10).sort(() => Math.random() - 0.5);
    const bestRace = await Promise.all(bestValues.map((v) => post(IDS.fxBest, ok({ memberId: race, value: v }))));
    const [sumRow] = await q('SELECT score, version FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, race]);
    const [bestRow] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxBest, race]);
    const versions = new Set(sumRace.map((r) => r.data?.version));
    const raceRedis = await until(async () => (await get(`/v1/rankings/${IDS.fxSum}/members/${race}`)).data?.score === 20
        && (await get(`/v1/rankings/${IDS.fxBest}/members/${race}`)).data?.score === 200
        && Number(await R.hGet(seasonKeys(IDS.fxSum, 1).ver, race)) === 20, 15000);
    check('X12 같은 멤버 첫 제출 20개 동시(다른 requestId): SUM 모두 0·version 1..20 각각 한 번·원장 20/20, BEST 최고값 200, Redis 일치',
        sumRace.every((r) => r.result === 0) && versions.size === 20 && Number(sumRow?.score) === 20 && sumRow?.version === 20
        && bestRace.every((r) => r.result === 0) && Number(bestRow?.score) === 200 && raceRedis >= 0,
        `(SUM ${sumRace.map((r) => r.result).filter((x) => x !== 0)}, ${sumRow?.score}/${sumRow?.version}, BEST ${bestRow?.score}, ${raceRedis}ms)`);

    // 락 대기 5초 초과(1205)를 처리 제한 15초 API로 받는다: SP가 롤백하고 50001/500. 멱등 키도 롤백되어 같은 requestId 재시도는 새로 반영
    const lw = `${tag}-lw`;
    await post(IDS.fxSum, ok({ memberId: lw, value: 10 }), PROXIED);
    const lwReq = ok({ memberId: lw, value: 4 });
    const h3 = await M.getConnection();
    let lwRes;
    let lwMs;
    try {
        await h3.query('START TRANSACTION');
        await h3.query('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ? FOR UPDATE', [IDS.fxSum, lw]);
        const t = Date.now();
        lwRes = await post(IDS.fxSum, lwReq, PROXIED);
        lwMs = Date.now() - t;
    } finally {
        await h3.query('ROLLBACK');
        h3.release();
    }
    const [{ n: lwKeys }] = await q('SELECT COUNT(request_id) n FROM ranking_submit_key WHERE ranking_id = ? AND season_no = 1 AND request_id = ?', [IDS.fxSum, lwReq.requestId]);
    const [{ score: lwScore }] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, lw]);
    const lwRetry = await post(IDS.fxSum, lwReq, PROXIED);
    check('X13 API 경유 락 대기 초과(1205): 약 5초 뒤 50001/500, 원장·멱등 키 롤백(점수 10, 키 0), 같은 requestId 재시도는 새로 반영(14)',
        lwRes.result === 50001 && lwRes.status === 500 && lwMs >= 4800 && lwMs < 8000 && lwKeys === 0 && Number(lwScore) === 10
        && lwRetry.result === 0 && lwRetry.data.replayed === false && lwRetry.data.score === 14, `(${lwRes.result}/${lwRes.status}, ${lwMs}ms, 키 ${lwKeys}, 점수 ${lwScore}, 재시도 ${lwRetry.data?.score})`);

    // 제출 경로 데드락: SP는 멱등 키를 넣은 뒤 멤버 행을 잠근다. holder가 멤버 행을 잡은 채 같은 키를 넣으면 서로를 기다린다.
    // holder는 미리 키 20개를 넣어(롤백 대상) SP보다 무겁게 만든다 — InnoDB는 가벼운 쪽(SP)을 희생시킨다 → 1213 → 50001, 전부 롤백
    const dl = `${tag}-dl`;
    await post(IDS.fxSum, ok({ memberId: dl, value: 10 }));
    const dlReq = ok({ memberId: dl, value: 3 });
    const dlLog0 = logCount('tx1', 'DB 오류 1213', 'api');
    const keyInsert = 'INSERT INTO ranking_submit_key (ranking_id, season_no, request_id, member_id, input_value, rejected, created_at) VALUES ?';
    const h5 = await M.getConnection();
    let dlRes;
    let dlHolderErr = null;
    try {
        await h5.query('START TRANSACTION');
        await h5.query(keyInsert, [Array.from({ length: 20 }, (_, i) => [IDS.fxSum, 1, `${tag}-dlpad-${i}`, dl, 0, null, new Date()])]);
        await h5.query('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ? FOR UPDATE', [IDS.fxSum, dl]);
        const pending = post(IDS.fxSum, dlReq);
        await sleep(500);
        try {
            await h5.query(keyInsert, [[[IDS.fxSum, 1, dlReq.requestId, dl, 3, null, new Date()]]]);
        } catch (e) {
            dlHolderErr = e.errno;
        }
        dlRes = await pending;
    } finally {
        await h5.query('ROLLBACK');
        h5.release();
    }
    const [{ n: dlKeys }] = await q('SELECT COUNT(request_id) n FROM ranking_submit_key WHERE ranking_id = ? AND season_no = 1 AND request_id = ?', [IDS.fxSum, dlReq.requestId]);
    const [{ score: dlScore }] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, dl]);
    const dlRetry = await post(IDS.fxSum, dlReq);
    const dlLogged = await until(async () => logCount('tx1', 'DB 오류 1213', 'api') > dlLog0, 5000);
    check('X21 제출 경로 데드락: SP가 희생돼 50001/500(로그 1213), 원장·멱등 키 롤백(점수 10, 키 0), 같은 requestId 재시도는 새로 반영(13)',
        dlRes.result === 50001 && dlRes.status === 500 && dlHolderErr === null && dlLogged >= 0 && dlKeys === 0 && Number(dlScore) === 10
        && dlRetry.result === 0 && dlRetry.data.replayed === false && dlRetry.data.score === 13,
        `(${dlRes.result}/${dlRes.status}, holder ${dlHolderErr}, 키 ${dlKeys}, 점수 ${dlScore}, 재시도 ${dlRetry.data?.score})`);

    // Redis 무응답(연결 유지): 제출은 Redis 제한 시간(0.5초) 뒤 성공, 조회는 2007. API 처리 제한(15초)까지 매달리지 않는다
    const hm = `${tag}-hang`;
    redisProxy.hang();
    let t = Date.now();
    const hangSubmit = await post(IDS.fxSum, ok({ memberId: hm, value: 2 }), PROXIED);
    const hangSubmitMs = Date.now() - t;
    t = Date.now();
    const hangRead = await get(`/v1/rankings/${IDS.fxSum}/members/${hm}`, PROXIED);
    const hangReadMs = Date.now() - t;
    await redisProxy.up();
    const hangBack = await until(async () => (await get(`/v1/rankings/${IDS.fxSum}/members/${hm}`, PROXIED)).data?.score === 2, 15000);
    check('X14 Redis 무응답: 제출 0(약 0.5초), 조회 2007/503(약 0.5초), 재개 후 조회 정상',
        hangSubmit.result === 0 && hangSubmitMs >= 400 && hangSubmitMs < 3000 && hangRead.result === 2007 && hangRead.status === 503 && hangReadMs >= 400 && hangReadMs < 3000 && hangBack >= 0,
        `(제출 ${hangSubmit.result} ${hangSubmitMs}ms, 조회 ${hangRead.result} ${hangReadMs}ms, 재개 ${hangBack}ms)`);

    // Redis 실행 중 다운 → 복구: API·워커 모두 경고 후 재접속, 다운 중 제출은 워커가 복구 뒤 순위표에 채운다
    const rlog = (id, text, kind) => logCount(id, text, kind);
    const rd0 = [rlog('tx12', 'redis unavailable', 'api'), rlog('t11', 'redis unavailable'), rlog('tx12', 'redis ready', 'api'), rlog('t11', 'redis ready')];
    await redisProxy.down();
    const warned = await until(async () => rlog('tx12', 'redis unavailable', 'api') > rd0[0] && rlog('t11', 'redis unavailable') > rd0[1], 10000);
    const rdm = `${tag}-rdown`;
    const rdSubmit = await post(IDS.fxSum, ok({ memberId: rdm, value: 4 }), PROXIED);
    const rdRead = await get(`/v1/rankings/${IDS.fxSum}/members/${rdm}`, PROXIED);
    const rdBoard = await R.zScore(seasonKeys(IDS.fxSum, 1).board, rdm);
    await redisProxy.up();
    const rdBack = await until(async () => rlog('tx12', 'redis ready', 'api') > rd0[2] && rlog('t11', 'redis ready') > rd0[3]
        && (await get(`/v1/rankings/${IDS.fxSum}/members/${rdm}`, PROXIED)).data?.score === 4, 30000);
    check('X15 Redis 실행 중 다운 → 복구: API·워커 경고, 제출 0·조회 2007·순위표에 없음 → 재접속 로그, 워커가 채워 조회 4',
        warned >= 0 && rdSubmit.result === 0 && rdRead.result === 2007 && rdBoard === null && rdBack >= 0, `(경고 ${warned}ms, 제출 ${rdSubmit.result}, 조회 ${rdRead.result}, 복구 ${rdBack}ms)`);

    // 로그 DB 실행 중 다운 → 복구: 제출은 계속 성공, 이력 실패 경고, 복구 뒤 이력이 다시 쌓인다
    // 연결 상태 로그는 상태가 바뀔 때만 한 줄: 다운 중 여러 번 실패해도 unreachable 1, 복구 뒤 recovered 1
    const dbState = (db) => [logCount('tx12', `${db} db unreachable`, 'api'), logCount('tx12', `${db} db recovered`, 'api')];
    const lf0 = logCount('tx12', 'submit log write failed', 'api');
    const ls0 = dbState('log');
    await logProxy.down();
    const ldm = `${tag}-ldown`;
    const ldSubmit = await post(IDS.fxSum, ok({ memberId: ldm, value: 1 }), PROXIED);
    await post(IDS.fxSum, ok({ memberId: ldm, value: 1 }), PROXIED);
    const ldWarn = await until(async () => logCount('tx12', 'submit log write failed', 'api') >= lf0 + 2, 15000);
    await logProxy.up();
    const lum = `${tag}-lup`;
    const luSubmit = await post(IDS.fxSum, ok({ memberId: lum, value: 1 }), PROXIED);
    const logRowsOf = async (m) => (await LM.query('SELECT COUNT(log_ranking_submit_id) n FROM log_ranking_submit WHERE ranking_id = ? AND member_id = ?', [IDS.fxSum, m]))[0][0].n;
    const luLogged = await until(async () => await logRowsOf(lum) === 1, 15000);
    const ldRows = await logRowsOf(ldm);
    // 로그 파일 쓰기는 비동기라 줄이 보일 때까지 기다린 뒤 센다
    await until(async () => dbState('log').every((n, i) => n > ls0[i]), 5000);
    const ls1 = dbState('log');
    check('X16 로그 DB 실행 중 다운 → 복구: 제출 0·이력 실패 경고(행 없음)·unreachable 1줄 → 복구 뒤 이력 기록·recovered 1줄',
        ldSubmit.result === 0 && ldWarn >= 0 && ldRows === 0 && luSubmit.result === 0 && luLogged >= 0 && ls1[0] - ls0[0] === 1 && ls1[1] - ls0[1] === 1,
        `(${ldSubmit.result}, 경고 ${ldWarn}ms, 다운 중 행 ${ldRows}, 복구 ${luLogged}ms, 상태 로그 +${ls1[0] - ls0[0]}/+${ls1[1] - ls0[1]})`);

    // 메인 DB 실행 중 다운 → 복구: 제출은 바로 50001로 실패(반영 없음, SP 내부 DB 오류와 같은 코드), 프로세스는 살아 있고, 복구 뒤 제출 성공
    const mdm = `${tag}-mdown`;
    const ms0 = dbState('main');
    await dbProxy.down();
    t = Date.now();
    const mdSubmit = await post(IDS.fxSum, ok({ memberId: mdm, value: 1 }), PROXIED);
    const mdMs = Date.now() - t;
    const mdSecond = await post(IDS.fxSum, ok({ memberId: mdm, value: 1 }), PROXIED);
    await dbProxy.up();
    const mdBack = await until(async () => (await post(IDS.fxSum, ok({ memberId: mdm, value: 1 }), PROXIED)).result === 0, 20000);
    const [mdRow] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, mdm]);
    await until(async () => dbState('main').every((n, i) => n > ms0[i]), 5000);
    const ms1 = dbState('main');
    check('X17 메인 DB 실행 중 다운 → 복구: 제출 2회 50001/500(즉시, 반영 없음)·unreachable 1줄, 프로세스 유지, 복구 뒤 제출 성공(점수 1)·recovered 1줄',
        mdSubmit.status === 500 && mdSubmit.result === 50001 && mdSecond.result === 50001 && mdMs < 3000 && workers.has('tx12') && mdBack >= 0 && Number(mdRow?.score) === 1
        && ms1[0] - ms0[0] === 1 && ms1[1] - ms0[1] === 1,
        `(${mdSubmit.result}/${mdSubmit.status} ${mdMs}ms, 복구 ${mdBack}ms, 점수 ${mdRow?.score}, 상태 로그 +${ms1[0] - ms0[0]}/+${ms1[1] - ms0[1]})`);

    // 메인 DB 무응답(연결 유지)에 동시 제출: 커넥션 수만큼은 DB에서 멈추고, 대기열(커넥션 × 20)까지 기다리고, 넘는 요청은 바로 50001.
    // DB에 보낸 호출은 호출 제한(7초)에 커넥션을 버리고 50001·unreachable 1줄. 재개 뒤 대기열은 곧바로 처리되고 recovered 1줄
    const poolSize = config.db.poolSize;
    const burstN = poolSize * 21 + 50;
    const hb = `${tag}-hb`;
    const hs0 = dbState('main');
    dbProxy.hang();
    t = Date.now();
    const burstP = Array.from({ length: burstN }, (_, i) => post(IDS.fxSum, ok({ memberId: `${hb}-${i}`, value: 1 }), PROXIED).then((r) => ({ ...r, ms: Date.now() - t })));
    const hungWarn = await until(async () => dbState('main')[0] > hs0[0], 15000);
    await dbProxy.up();
    const hbRes = await Promise.all(burstP);
    t = Date.now();
    const hbAfter = await post(IDS.fxSum, ok({ memberId: `${hb}-after`, value: 1 }), PROXIED);
    const hbAfterMs = Date.now() - t;
    await until(async () => dbState('main')[1] > hs0[1], 5000);
    const hs1 = dbState('main');
    const fast = hbRes.filter((r) => r.result === 50001 && r.ms < 2000).length;
    const cut = hbRes.filter((r) => r.result === 50001 && r.ms >= 6500).length;
    const hbOk = hbRes.filter((r) => r.result === 0).length;
    const [{ n: hbRows }] = await q('SELECT COUNT(member_id) n FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id LIKE ?', [IDS.fxSum, `${hb}-%`]);
    // 하트비트·재조회가 같은 풀을 쓰므로 바로 실패하는 수는 몇 개 더 많을 수 있다.
    // 7초에 잘린 호출은 버린 커넥션의 SP가 재개 뒤 커밋될 수 있다(10.3, D-71 — 같은 requestId 재시도로 맞춘다). 그래서 행 수는 잘린 수만큼 더 많을 수 있다.
    check(`X22 메인 DB 무응답에 ${burstN}건 동시: 대기열 초과 ~50건 즉시 50001, DB에 보낸 호출은 7초에 50001·unreachable 1줄, 나머지는 재개 뒤 반영, 새 제출 즉시 성공·recovered 1줄`,
        fast >= 50 && fast <= 53 && cut >= 1 && fast + cut + hbOk === burstN && Number(hbRows) >= hbOk + 1 && Number(hbRows) <= hbOk + 1 + cut && hbAfter.result === 0 && hbAfterMs < 1000
        && hungWarn >= 6500 && hs1[0] - hs0[0] === 1 && hs1[1] - hs0[1] === 1,
        `(즉시 ${fast}, 7초 ${cut}, 반영 ${hbOk}/${hbRows}행, 경고 ${hungWarn}ms, 재개 뒤 ${hbAfter.result} ${hbAfterMs}ms, 상태 로그 +${hs1[0] - hs0[0]}/+${hs1[1] - hs0[1]}, 기타 ${hbRes.filter((r) => r.result !== 0 && r.result !== 50001).map((r) => r.result)})`);

    // 제출 처리 중(SP가 락 대기 중) API 프로세스 강제 종료. 커밋 여부와 무관하게 같은 requestId 재시도로 정확히 한 번 반영되고, Redis도 맞춰진다
    const km = `${tag}-kill`;
    await post(IDS.fxSum, ok({ memberId: km, value: 10 }), DOOMED);
    const kmReq = ok({ memberId: km, value: 5 });
    const h4 = await M.getConnection();
    let killed;
    let lockWaits;
    try {
        await h4.query('START TRANSACTION');
        await h4.query('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ? FOR UPDATE', [IDS.fxSum, km]);
        const pending = post(IDS.fxSum, kmReq, DOOMED).then((r) => ({ r }), (e) => ({ e }));
        await sleep(1000);
        [{ n: lockWaits }] = await q("SELECT COUNT(trx_id) n FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'");
        stopProcess('tx13');
        killed = await pending;
    } finally {
        await h4.query('ROLLBACK');
        h4.release();
    }
    await sleep(1000);
    const [{ score: kmAfter }] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, km]);
    const kmRetry = await post(IDS.fxSum, kmReq);
    const kmRedis = await until(async () => (await get(`/v1/rankings/${IDS.fxSum}/members/${km}`)).data?.score === 15, 20000);
    const [{ score: kmFinal }] = await q('SELECT score FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND member_id = ?', [IDS.fxSum, km]);
    check('X18 제출 처리 중(락 대기) API 강제 종료 → 같은 requestId 재시도로 정확히 한 번 반영(15), Redis도 15',
        killed?.e !== undefined && lockWaits >= 1 && kmRetry.result === 0 && kmRetry.data.score === 15 && Number(kmFinal) === 15 && kmRedis >= 0,
        `(응답 ${killed?.e ? '연결 끊김' : killed?.r?.result}, 락 대기 ${lockWaits}, 종료 뒤 원장 ${kmAfter}=${Number(kmAfter) === 15 ? '서버가 커밋' : '롤백'}, 재시도 replayed ${kmRetry.data?.replayed}, ${kmRedis}ms)`);

    // 메인 DB에 닿지 않으면 API·워커 모두 기동을 거부하고 종료한다
    const apiExit = await runUntilExit('api', 'tx3', { API_PORT: String(PORT + 2), DB_PORT: DEAD_PORT });
    const workerExit = await runUntilExit('worker', 'tx4', { DB_PORT: DEAD_PORT });
    check('X6 메인 DB 접속 불가: API·워커 기동 거부(종료 코드 1)', apiExit === 1 && workerExit === 1, `(${apiExit}, ${workerExit})`);

    // 잘못된 설정과 포트 충돌. 포트 충돌은 하트비트를 기록한 뒤에 실패하므로 그 행을 지우고 끝나야 한다(migrate가 산 인스턴스로 보지 않게)
    const retentionExit = await runUntilExit('api', 'tx14', { API_PORT: String(PORT + 5), LOG_RETENTION_DAYS: '0' });
    const intExit = await runUntilExit('worker', 'tx15', { API_TIMEOUT_MS: 'abc' });
    // 월 테이블 보관(3 × 28 = 84일)이 운영 보관(90일)보다 짧으면 옮기자마자 지울 대상이 된다
    const archiveExit = await runUntilExit('worker', 'tx17', { LOG_RETENTION_DAYS: '90', LOG_ARCHIVE_MONTHS: '3' });
    const beats = async () => new Set((await q('SELECT instance_id FROM instance_heartbeat')).map((r) => r.instance_id));
    const beats0 = await beats();
    const busy0 = logCount('tx16', 'api startup failed', 'api');
    const busyExit = await runUntilExit('api', 'tx16', { API_PORT: String(PORT) });
    const leftover = [...await beats()].filter((x) => !beats0.has(x)).length;
    check('X19 잘못된 설정(LOG_RETENTION_DAYS 0, 정수 아닌 값, 월 테이블 보관 < 운영 보관)·포트 충돌: 종료 코드 1, 포트 충돌은 시작 실패 로그·하트비트 행 남기지 않음',
        retentionExit === 1 && intExit === 1 && archiveExit === 1 && busyExit === 1 && logCount('tx16', 'api startup failed', 'api') > busy0 && leftover === 0,
        `(${retentionExit}, ${intExit}, ${archiveExit}, ${busyExit}, 남은 하트비트 ${leftover})`);

    // 인스턴스가 떠 있는 동안 migrate는 거부한다
    const mig = await new Promise((done) => {
        const p = spawn(process.execPath, ['dist/migrate.js'], { env: process.env });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => done({ code, out }));
    });
    check('X7 실행 중 인스턴스가 있으면 migrate 거부', mig.code !== 0 && mig.out.includes('실행 중인 인스턴스가 있어 migrate를 거부합니다'), `(code ${mig.code})`);

    await revokePoll;
    check('X20 키 폐기: 폐기 직후는 아직 통과(캐시), 재조회 주기(30초) 안에 2002', beforeRevoke.result === 0 && revoked.result === 0 && rightAfter.result === 0
        && revokeSeenMs >= 0 && revokeSeenMs <= 31000, `(폐기 직후 ${rightAfter.result}, 폐기 후 ${revokeSeenMs}ms에 2002)`);
}

/**
 * 워커 장애 주입: Redis·로그 DB가 죽은 워커(정산은 쉬고 로그 정리는 실패 로그), 가순위·확정 도중 워커 강제 종료 후 다른 워커가 이어받기,
 * 두 워커 동시 실행. 시즌: 2,500명, 점수 0..N-1을 섞어 넣어 기대 순서가 하나로 정해진다 (DESC).
 * @returns 없음
 */
async function workerFaults() {
    const id = IDS.fxSettle;
    await createDefinition(id, { settleDelay: 1, reviewPeriod: 3600 });
    await createSeason(id, 1, -60, -30, 3);
    const [{ start_at: startAt }] = await q('SELECT start_at FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [id]);
    const scores = Array.from({ length: N }, (_, i) => i).sort(() => Math.random() - 0.5);
    await q('INSERT INTO ranking_entry (ranking_id, season_no, member_id, score, achieved_at, version, updated_at) VALUES ?',
        [scores.map((sc, i) => [id, 1, `w${i}`, sc, startAt, 1, new Date()])]);
    const expected = scores.map((sc, i) => [sc, `w${i}`]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    // 시작 조건(7.1)은 정산 구간에서 본다. 여기서는 SETTLING으로 바로 둔다
    await q('UPDATE ranking_season SET status = 4 WHERE ranking_id = ? AND season_no = 1', [id]);
    const status = async () => (await q('SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [id]))[0].status;

    // Redis·로그 DB가 죽은 워커: 정산은 건너뛰고(시즌 키를 못 지우므로), 로그 정리는 실패 로그를 남기고, 프로세스는 살아 있다
    const fast = { SCHEDULER_INTERVAL_MS: '300', SETTLE_CHUNK: '5' };
    const failed0 = logCount('tx5', 'log cleanup cycle failed');
    startWorker('tx5', { ...fast, REDIS_URL: `redis://127.0.0.1:${DEAD_PORT}`, DB_LOG_PORT: DEAD_PORT });
    const logFail = await until(async () => logCount('tx5', 'log cleanup cycle failed') > failed0, 15000);
    await sleep(2000);
    const [{ n: outRows }] = await q('SELECT COUNT(member_id) n FROM ranking_entry_settling WHERE ranking_id = ?', [id]);
    check('X8 Redis·로그 DB 장애 워커: 정산 건너뜀(작업 테이블 비어 있음, SETTLING 유지), 로그 정리 실패 로그, 프로세스 유지',
        logFail >= 0 && outRows === 0 && await status() === 4 && workers.has('tx5'), `(${logFail}ms, settling ${outRows}행)`);
    stopProcess('tx5');

    // 정상 워커 2대 동시. 가순위가 진행 중일 때(작업 테이블에 행, 일부 순위 매김) 둘 다 강제 종료 → 세 번째 워커가 이어받는다
    startWorker('tx6', fast);
    startWorker('tx7', fast);
    let midSettle = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        const [{ n, r }] = await q('SELECT COUNT(member_id) n, COUNT(final_rank) r FROM ranking_entry_settling WHERE ranking_id = ?', [id]);
        if (n > 0 && r >= 100) {
            midSettle = r;
            break;
        }
        await sleep(10);
    }
    stopProcess('tx6');
    stopProcess('tx7');
    await sleep(500);
    const [{ r: frozen }] = await q('SELECT COUNT(final_rank) r FROM ranking_entry_settling WHERE ranking_id = ?', [id]);
    startWorker('tx8', fast);
    const reviewed = await until(async () => await status() === 5, 60000);
    const settled = await finalOrder(id);
    check('X9 가순위 도중 워커 2대 강제 종료 → 다른 워커가 이어받아 REVIEW, 1..N 연속·기대 순서, 작업 테이블 원상복구',
        midSettle !== null && frozen < N && reviewed >= 0 && settled.ranks.every((r, i) => r === i + 1) && settled.members.join() === expected.join() && await settlingClean(),
        `(종료 시점 ${midSettle}/${N}, 종료 후 ${frozen}, ${reviewed}ms)`);
    stopProcess('tx8');

    // 확정 도중 강제 종료: 제재 2명, 보상 구간. FINALIZING에서 보상 판정이 진행 중일 때 죽이고 다른 워커가 이어받는다
    const banned = [expected[3], expected[500]];
    await ban(id, banned);
    await q('INSERT INTO ranking_reward_tier (ranking_id, tier_no, range_type, range_from, range_to, reward_code) VALUES (?, 1, 1, 1, 10, ?), (?, 2, 2, 1, 10, ?)', [id, 'TOP10', id, 'P10']);
    await q('UPDATE ranking_season SET review_until = NOW(3) - INTERVAL 1 SECOND WHERE ranking_id = ? AND season_no = 1', [id]);
    startWorker('tx9', fast);
    let midFinal = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 30000) {
        const [{ s, judged }] = await q(`SELECT (SELECT status FROM ranking_season WHERE ranking_id = ? AND season_no = 1) s,
                                                COUNT(member_id) judged FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND reward_status = 1`, [id, id]);
        if (s === 6 && judged > 0) {
            midFinal = judged;
            break;
        }
        await sleep(10);
    }
    stopProcess('tx9');
    await sleep(500);
    const stuck = await status();
    startWorker('tx10', fast);
    const delivering = await until(async () => await status() === 7, 60000);
    const fin = await q('SELECT member_id, final_rank, reward_code FROM ranking_entry WHERE ranking_id = ? AND season_no = 1 AND final_rank IS NOT NULL ORDER BY final_rank', [id]);
    const expFin = expected.filter((m) => !banned.includes(m));
    const [{ top }] = await q('SELECT COUNT(final_rank) top FROM ranking_season_top WHERE ranking_id = ?', [id]);
    // RANK 1~10위 TOP10 먼저, 그 뒤 앞 사람 비율 10% 미만이면 P10 (D-69)
    const tierOk = fin.every((r) => r.reward_code === (r.final_rank <= 10 ? 'TOP10' : (r.final_rank - 1) * 100 < 10 * (N - 2) ? 'P10' : null));
    check('X10 확정 도중 워커 강제 종료 → 다른 워커가 이어받아 DELIVERING, 제재 제외 1..N-2 연속, 보상 판정, Top N 100행',
        midFinal !== null && stuck === 6 && delivering >= 0 && fin.length === N - 2 && fin.every((r, i) => r.final_rank === i + 1 && r.member_id === expFin[i]) && tierOk && top === 100,
        `(종료 시점 PENDING ${midFinal}, 종료 후 상태 ${stuck}, ${delivering}ms)`);
}

// ------------------------------------------------------------------------------------------------ 관리 API

/** 관리 API 포트. API 구간이 TEST_PORT ~ TEST_PORT+5를 쓴다 */
const ADMIN_PORT = PORT + 6;
const ADMIN_BASE = `http://localhost:${ADMIN_PORT}`;
const ADMIN_ORIGIN = 'https://gm.test';

/**
 * 관리 CLI를 실행한다. 초기 비밀번호는 표준 출력에서 읽어 메모리에만 둔다.
 * @param args CLI 인자
 * @returns 종료 코드와 출력된 초기 비밀번호 (없으면 null)
 */
async function adminCli(args) {
    const p = spawn(process.execPath, ['dist/adminctl.js', ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, INSTANCE_ID: 'tcli' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const code = await new Promise((ok) => p.on('exit', ok));
    return { code, password: /초기 비밀번호[^\n]*\n(\S+)/.exec(out)?.[1] ?? null };
}

/**
 * 관리 API를 부른다.
 * @param method HTTP 메서드
 * @param path 경로 (/admin/v1 뒤)
 * @param o 바디, 세션 토큰, Origin
 * @returns { status, body, token(새 세션 쿠키 값, 지우기면 ''), setCookie }
 */
async function adm(method, path, { body, token, origin } = {}) {
    const headers = {};
    if (body !== undefined)
        headers['content-type'] = 'application/json';
    if (token)
        headers.cookie = `__Host-podium_admin=${token}`;
    if (origin)
        headers.origin = origin;
    const res = await fetch(`${ADMIN_BASE}/admin/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.getSetCookie()[0] ?? '';
    const m = /^__Host-podium_admin=([^;]*)/.exec(setCookie);
    return { status: res.status, body: await res.json(), token: m ? m[1] : undefined, setCookie };
}

/**
 * 로그인하고 세션 토큰을 돌려준다.
 * @param loginId 아이디
 * @param password 비밀번호
 * @returns { token, body }
 */
async function admLogin(loginId, password) {
    const r = await adm('POST', '/auth/login', { body: { loginId, password } });
    return { token: r.token, body: r.body, status: r.status };
}

/**
 * 관리 API 회귀 (01_DESIGN 10.4, D-74): 첫 admin CLI, 로그인·쿠키 속성, 초기 비밀번호 변경 강제, 비밀번호 규칙·변경과 세션 종료,
 * 역할, 계정 생성·중복·수정·사용중지·초기화·잠금 해제, 연속 실패 잠금(동시 실패 포함), 잠금 중 비밀번호 대입 차단, Origin 검사,
 * 유휴·최대 수명 만료, SP 역할 재확인, 감사 로그와 비밀번호 마스킹.
 * 포트: TEST_PORT+6.
 * @returns 없음
 */
async function adminScenarios() {
    const created = await adminCli(['create', '--login-id', 'rtest-root', '--name', 'Root']);
    const dup = await adminCli(['create', '--login-id', 'RTEST-ROOT', '--name', 'Root2']);
    const [rootRow] = await q("SELECT admin_account_id id, role, status, must_change_password mc FROM admin_account WHERE login_id = 'rtest-root'");
    check('G1 CLI 첫 admin 생성·대소문자 무시 중복 거부', created.code === 0 && created.password?.length === 16 && rootRow?.role === 3 && rootRow.mc === 1 && dup.code === 1,
        `(code ${created.code}/${dup.code})`);
    const rootId = rootRow.id;

    spawnTracked('tadm', 'admin', { ADMIN_PORT: String(ADMIN_PORT), ADMIN_ORIGINS: ADMIN_ORIGIN });
    const t0 = Date.now();
    let first;
    while (Date.now() - t0 < 20000) {
        try {
            first = await adm('POST', '/auth/login', { body: { loginId: 'rtest-root', password: created.password } });
            break;
        } catch {
            await sleep(200);
        }
    }
    const attrs = first?.setCookie ?? '';
    check('G2 로그인·쿠키 속성', first?.status === 200 && first.body.data?.mustChangePassword === true && first.token?.length === 43
        && ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'].every((a) => attrs.includes(a)) && !/Domain=/i.test(attrs), attrs.replace(/=[^;]*/, '=***'));

    const blocked = await adm('GET', '/accounts', { token: first.token });
    const me = await adm('GET', '/auth/me', { token: first.token });
    check('G3 초기 비밀번호면 계정 목록 1403, me는 허용', blocked.body.result === 1403 && me.status === 200 && me.body.data?.role === 3, `(${blocked.body.result}, ${me.status})`);

    const short = await adm('POST', '/auth/password', { token: first.token, body: { currentPassword: created.password, newPassword: 'short' } });
    const wrong = await adm('POST', '/auth/password', { token: first.token, body: { currentPassword: 'not-the-password', newPassword: 'root-password-0001' } });
    const second = await admLogin('rtest-root', created.password);
    const changed = await adm('POST', '/auth/password', { token: first.token, body: { currentPassword: created.password, newPassword: 'root-password-0001' } });
    const oldSession = await adm('GET', '/auth/me', { token: first.token });
    const otherSession = await adm('GET', '/auth/me', { token: second.token });
    const root = changed.token;
    const list = await adm('GET', '/accounts', { token: root });
    const [{ fc }] = await q('SELECT fail_count fc FROM admin_account WHERE admin_account_id = ?', [rootId]);
    check('G4 비밀번호 규칙 2008·현재 비밀번호 틀림 1401·변경 후 기존 세션 모두 종료·새 세션 발급',
        short.body.result === 2008 && wrong.body.result === 1401 && changed.status === 200 && changed.body.data?.mustChangePassword === false
        && oldSession.body.result === 2002 && otherSession.body.result === 2002 && list.status === 200 && list.body.data.total >= 1 && fc === 0,
        `(${short.body.result}, ${wrong.body.result}, ${changed.status}, ${oldSession.body.result}/${otherSession.body.result}, ${list.status})`);

    const op = await adm('POST', '/accounts', { token: root, body: { loginId: 'rtest-op', name: 'Op', role: 2 } });
    const opDup = await adm('POST', '/accounts', { token: root, body: { loginId: 'RTEST-OP', name: 'Op2', role: 2 } });
    const badId = await adm('POST', '/accounts', { token: root, body: { loginId: 'rtest op', name: 'Op3', role: 2 } });
    const opId = op.body.data?.accountId;
    const opInitial = op.body.data?.initialPassword;
    await sleep(300);
    const adminLog = existsSync('logs/app.log.admin.tadm') ? readFileSync('logs/app.log.admin.tadm', 'utf8') : '';
    check('G5 계정 생성·중복 1407·아이디 형식 2001·응답 로그에 초기 비밀번호 없음',
        op.status === 200 && opInitial?.length === 16 && opDup.body.result === 1407 && badId.body.result === 2001
        && adminLog.includes('"initialPassword":"***"') && !adminLog.includes(opInitial) && !adminLog.includes(created.password) && !adminLog.includes('root-password-0001'),
        `(${op.status}, ${opDup.body.result}, ${badId.body.result})`);

    const opFirst = await admLogin('rtest-op', opInitial);
    const opSet = await adm('POST', '/auth/password', { token: opFirst.token, body: { currentPassword: opInitial, newPassword: 'op-password-00001' } });
    const opToken = opSet.token;
    const opList = await adm('GET', '/accounts', { token: opToken });
    const opAudit = await adm('GET', '/audit', { token: opToken });
    check('G6 operator는 계정·감사 API 2003', opList.body.result === 2003 && opAudit.body.result === 2003, `(${opList.body.result}, ${opAudit.body.result})`);

    // 연속 실패 잠금: 4번은 1401, 5번째에 1402. 잠긴 동안은 맞는 비밀번호도 1402
    const fails = [];
    for (let i = 0; i < 5; i++)
        fails.push((await admLogin('rtest-op', `wrong-password-${i}`)).body.result);
    const lockedRight = await admLogin('rtest-op', 'op-password-00001');
    // 잠긴 동안 세션으로 현재 비밀번호를 대입해도 비교하지 않는다 (맞는 값도 1402)
    const lockedChange = await adm('POST', '/auth/password', { token: opToken, body: { currentPassword: 'op-password-00001', newPassword: 'op-password-00002' } });
    const unlock = await adm('POST', `/accounts/${opId}/unlock`, { token: root, body: {} });
    const afterUnlock = await admLogin('rtest-op', 'op-password-00001');
    check('G7 5회 실패 잠금·잠금 중 로그인과 비밀번호 대입 1402·admin 잠금 해제',
        fails.join() === '1401,1401,1401,1401,1402' && lockedRight.body.result === 1402 && lockedChange.body.result === 1402 && unlock.status === 200 && afterUnlock.status === 200,
        `(${fails.join()}, ${lockedRight.body.result}, ${lockedChange.body.result}, ${unlock.status}, ${afterUnlock.status})`);

    // 동시 실패 5건: 계정 행 조건부 UPDATE라 횟수가 빠지지 않고 정확히 잠긴다
    await q('UPDATE admin_account SET fail_count = 0, locked_until = NULL WHERE admin_account_id = ?', [opId]);
    const parallel = await Promise.all(Array.from({ length: 5 }, (_, i) => admLogin('rtest-op', `parallel-wrong-${i}`)));
    const [lockState] = await q('SELECT fail_count fc, locked_until > UTC_TIMESTAMP(3) locked FROM admin_account WHERE admin_account_id = ?', [opId]);
    check('G8 동시 실패 5건 → 잠김', lockState.locked === 1 && lockState.fc === 0 && parallel.every((r) => [1401, 1402].includes(r.body.result)),
        `(locked ${lockState.locked}, fc ${lockState.fc})`);
    await adm('POST', `/accounts/${opId}/unlock`, { token: root, body: {} });

    const nobody = await admLogin('rtest-nobody', 'whatever-password');
    const opLive = (await admLogin('rtest-op', 'op-password-00001')).token;
    const disable = await adm('PATCH', `/accounts/${opId}`, { token: root, body: { status: 2 } });
    const afterDisable = await adm('GET', '/auth/me', { token: opLive });
    const disabledLogin = await admLogin('rtest-op', 'op-password-00001');
    const selfRole = await adm('PATCH', `/accounts/${rootId}`, { token: root, body: { role: 1 } });
    const selfStatus = await adm('PATCH', `/accounts/${rootId}`, { token: root, body: { status: 2 } });
    const selfName = await adm('PATCH', `/accounts/${rootId}`, { token: root, body: { name: 'Root Renamed', role: 3 } });
    check('G9 없는 아이디·사용중지 1401·사용중지 즉시 세션 종료·자기 역할/상태 1406(같은 값·이름은 허용)',
        nobody.body.result === 1401 && disable.status === 200 && afterDisable.body.result === 2002 && disabledLogin.body.result === 1401
        && selfRole.body.result === 1406 && selfStatus.body.result === 1406 && selfName.status === 200,
        `(${nobody.body.result}, ${afterDisable.body.result}, ${disabledLogin.body.result}, ${selfRole.body.result}/${selfStatus.body.result}/${selfName.status})`);

    await adm('PATCH', `/accounts/${opId}`, { token: root, body: { status: 1 } });
    const opAgain = (await admLogin('rtest-op', 'op-password-00001')).token;
    const before = await adm('GET', '/accounts', { token: opAgain });
    await adm('PATCH', `/accounts/${opId}`, { token: root, body: { role: 3 } });
    const promoted = await adm('GET', '/accounts', { token: opAgain });
    check('G10 역할 변경이 다음 요청부터 적용', before.body.result === 2003 && promoted.status === 200, `(${before.body.result} → ${promoted.status})`);

    const evil = await adm('POST', '/auth/login', { origin: 'https://evil.test', body: { loginId: 'rtest-root', password: 'root-password-0001' } });
    const good = await adm('POST', '/auth/login', { origin: ADMIN_ORIGIN, body: { loginId: 'rtest-root', password: 'root-password-0001' } });
    const evilGet = await adm('GET', '/auth/me', { origin: 'https://evil.test', token: root });
    check('G11 Origin 검사 (쓰기만, 허용 목록)', evil.body.result === 2003 && good.status === 200 && evilGet.status === 200, `(${evil.body.result}, ${good.status}, ${evilGet.status})`);

    const reset = await adm('POST', `/accounts/${opId}/password-reset`, { token: root, body: {} });
    const afterReset = await adm('GET', '/auth/me', { token: opAgain });
    const resetLogin = await admLogin('rtest-op', reset.body.data?.initialPassword);
    const cliReset = await adminCli(['reset-password', '--login-id', 'rtest-op']);
    const cliLogin = await admLogin('rtest-op', cliReset.password);
    check('G12 admin 초기화·CLI 초기화: 기존 세션 종료, 새 초기 비밀번호로 로그인, 변경 요구',
        reset.status === 200 && afterReset.body.result === 2002 && resetLogin.body.data?.mustChangePassword === true
        && cliReset.code === 0 && cliLogin.body.data?.mustChangePassword === true && resetLogin.token !== undefined,
        `(${reset.status}, ${afterReset.body.result}, cli ${cliReset.code})`);

    const idle = (await admLogin('rtest-root', 'root-password-0001')).token;
    const maxed = (await admLogin('rtest-root', 'root-password-0001')).token;
    await q("UPDATE admin_session SET last_seen_at = UTC_TIMESTAMP(3) - INTERVAL 31 MINUTE WHERE token_hash = UNHEX(SHA2(?, 256))", [idle]);
    await q("UPDATE admin_session SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE token_hash = UNHEX(SHA2(?, 256))", [maxed]);
    const idleRes = await adm('GET', '/auth/me', { token: idle });
    const maxRes = await adm('GET', '/auth/me', { token: maxed });
    const [{ n: left }] = await q('SELECT COUNT(admin_session_id) n FROM admin_session WHERE token_hash IN (UNHEX(SHA2(?, 256)), UNHEX(SHA2(?, 256)))', [idle, maxed]);
    const fresh = (await admLogin('rtest-root', 'root-password-0001')).token;
    await q("UPDATE admin_session SET last_seen_at = UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE WHERE token_hash = UNHEX(SHA2(?, 256))", [fresh]);
    await adm('GET', '/auth/me', { token: fresh });
    const [{ age }] = await q('SELECT TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP(3)) age FROM admin_session WHERE token_hash = UNHEX(SHA2(?, 256))', [fresh]);
    const logout = await adm('POST', '/auth/logout', { token: fresh, body: {} });
    const afterLogout = await adm('GET', '/auth/me', { token: fresh });
    check('G13 유휴·최대 수명 만료 2002와 행 삭제, last_seen 갱신, 로그아웃',
        idleRes.body.result === 2002 && maxRes.body.result === 2002 && left === 0 && age < 5 && logout.status === 200 && logout.setCookie.includes('Max-Age=0') && afterLogout.body.result === 2002,
        `(${idleRes.body.result}, ${maxRes.body.result}, 남은 ${left}, age ${age}, ${afterLogout.body.result})`);

    // SP 역할 재확인: 앱을 거치지 않고 operator·사용중지 계정을 요청자로 넘긴다
    await q('UPDATE admin_account SET role = 2 WHERE admin_account_id = ?', [opId]);
    const spOp = await callSp(A, 'SP_UPDATE_ADMIN_ACCOUNT', [opId, rootId, 'hijack', null, null]);
    await q('UPDATE admin_account SET role = 3, status = 2 WHERE admin_account_id = ?', [opId]);
    const spDisabled = await callSp(A, 'SP_RESET_ADMIN_PASSWORD', [opId, rootId, 'scrypt$x']);
    const spUnknownRole = await (async () => {
        await q('UPDATE admin_account SET role = 9, status = 1 WHERE admin_account_id = ?', [opId]);
        return callSp(A, 'SP_UNLOCK_ADMIN_ACCOUNT', [opId, rootId]);
    })();
    const [{ name: rootName }] = await q('SELECT display_name name FROM admin_account WHERE admin_account_id = ?', [rootId]);
    check('G14 SP 역할 재확인: operator·사용중지·알 수 없는 역할 1405',
        spOp.result === 1405 && spDisabled.result === 1405 && spUnknownRole.result === 1405 && rootName === 'Root Renamed',
        `(${spOp.result}, ${spDisabled.result}, ${spUnknownRole.result})`);

    const rootToken = (await admLogin('rtest-root', 'root-password-0001')).token;
    await sleep(300);
    const audit = await adm('GET', `/audit?accountId=${rootId}&size=100`, { token: rootToken });
    const actions = new Set(audit.body.data?.items.map((r) => r.action));
    const [{ n: failRows }] = (await LM.query("SELECT COUNT(log_admin_audit_id) n FROM log_admin_audit WHERE action = 'auth.login' AND role = 0 AND result_code IN (1401, 1402) AND login_id IN ('rtest-op', 'rtest-nobody')"))[0];
    const [{ n: cliRows }] = (await LM.query("SELECT COUNT(log_admin_audit_id) n FROM log_admin_audit WHERE admin_account_id = 0 AND login_id = 'SYSTEM' AND target_id IN (?, ?)", [String(rootId), String(opId)]))[0];
    const [updateRow] = (await LM.query("SELECT before_json b, after_json a FROM log_admin_audit WHERE action = 'account.update' AND target_id = ? AND result_code = 0 ORDER BY log_admin_audit_id LIMIT 1", [String(opId)]))[0];
    const auditText = JSON.stringify(audit.body);
    check('G15 감사 로그: 조작 기록, 로그인 실패(역할 0), CLI(SYSTEM), 변경 전·후, 비밀번호 없음',
        ['auth.login', 'auth.password', 'auth.logout', 'account.create', 'account.update', 'account.unlock', 'account.password_reset'].every((a) => actions.has(a))
        && failRows >= 10 && cliRows >= 2 && updateRow?.b?.status === 1 && updateRow?.a?.status === 2
        && !auditText.includes('root-password-0001') && !auditText.includes(opInitial),
        `(${[...actions].join(',')}, 실패 ${failRows}, CLI ${cliRows})`);
}

/**
 * 관리 CLI로 admin을 만들고 비밀번호를 바꿔 세션 토큰을 돌려준다.
 * @param loginId 아이디
 * @returns 세션 토큰
 */
async function admRoot(loginId) {
    const { password } = await adminCli(['create', '--login-id', loginId, '--name', 'Root']);
    const first = await admLogin(loginId, password);
    return (await adm('POST', '/auth/password', { token: first.token, body: { currentPassword: password, newPassword: `${loginId}-password` } })).token;
}

/**
 * 관리 API가 응답할 때까지 기다린다.
 * @returns 없음
 */
async function admUp() {
    await until(async () => {
        try {
            return (await fetch(`${ADMIN_BASE}/health`)).ok;
        } catch {
            return false;
        }
    }, 20000);
}

/**
 * 관리 API 랭킹 등록·수정 회귀 (01_DESIGN 2.7, 2.8, 10.4, D-79, D-81): 등록과 시즌 생성, 검증 거부(2009~2012, 2001), 역할,
 * 시즌 일정 변경, 운영 값, 조기 종료와 빈 파티션 정리, 늘리기(잘린 시즌 재계산), 끝난 랭킹·지난 시각 거부, ENDED, 보상 구간 교체,
 * SP 역할 재확인, 스케줄러 락 겹침, 감사 로그.
 * 포트: TEST_PORT+6.
 * @returns 없음
 */
async function rankingAdminScenarios() {
    // 픽스처 랭킹(FIXED 600초)이 정산 기간 검증(2.7)을 통과하도록 워커와 같은 안전마진·주기를 쓴다.
    const env = { RECOVERY_INTERVAL_MS: '1000', RECOVERY_MARGIN_SEC: '5' };
    spawnTracked('trk', 'admin', { ADMIN_PORT: String(ADMIN_PORT), ...env });
    await admUp();
    startWorker('trkw', { SCHEDULER_INTERVAL_MS: '500' });
    const root = await admRoot('rtest-rkroot');
    const vInit = (await adm('POST', '/accounts', { token: root, body: { loginId: 'rtest-rkview', name: 'Viewer', role: 1 } })).body.data.initialPassword;
    const vFirst = await admLogin('rtest-rkview', vInit);
    const viewer = (await adm('POST', '/auth/password', { token: vFirst.token, body: { currentPassword: vInit, newPassword: 'rtest-rkview-password' } })).token;
    const at = (sec) => new Date(Date.now() + sec * 1000).toISOString();
    const body = (code, o = {}) => ({
        rankingCode: `${RK_CODE}${code}`, name: 'RK', updateRule: 1, sortOrder: 1, scoreMax: 100000000, timeUnit: 2, timezone: 'Asia/Seoul',
        startAt: at(120), cycleType: 2, settleDelay: 600, reviewPeriod: 86400, historyRetention: 30,
        tiers: [{ tierNo: 1, rangeType: 1, rangeFrom: 1, rangeTo: 10, rewardCode: 'TOP10' }, { tierNo: 2, rangeType: 2, rangeFrom: 1, rangeTo: 10, rewardCode: 'P10' }], ...o,
    });

    const reg = await adm('POST', '/rankings', { token: root, body: body('weekly') });
    const id = reg.body.data?.rankingId;
    const [def] = await q('SELECT time_bits tb, status, update_rule ur FROM ranking_definition WHERE ranking_id = ?', [id]);
    const [{ n: tierCount }] = await q('SELECT COUNT(tier_no) n FROM ranking_reward_tier WHERE ranking_id = ?', [id]);
    check('K1 등록: ID 발급, time_bits = 53 − bits(score_max), 보상 구간 함께 저장', reg.status === 200 && id > 0 && def?.tb === 53 - 27 && def.status === 1 && tierCount === 2,
        `(${reg.status} ${JSON.stringify(reg.body)}, tb ${def?.tb})`);
    const made = await until(async () => {
        const s = await seasonsOf(id);
        return s.length === 3 && s.every((x) => x.status === 1 && x.parts === 2);
    });
    check('K2 시즌은 스케줄러가 만든다 (예정 3개, 파티션)', made >= 0, JSON.stringify(await seasonsOf(id)));

    const vReg = await adm('POST', '/rankings', { token: viewer, body: body('viewer') });
    const vList = await adm('GET', '/rankings?size=100', { token: viewer });
    const vGet = await adm('GET', `/rankings/${id}`, { token: viewer });
    const none = await adm('GET', '/rankings/4000000000', { token: viewer });
    check('K3 viewer는 조회만 (등록 2003), 상세에 구간·시즌, 없는 ID 1501',
        vReg.body.result === 2003 && vList.body.data?.items.some((r) => r.rankingId === id) && vGet.body.data?.tiers.length === 2
        && vGet.body.data?.seasons.length === 3 && vGet.body.data?.timeBits === 26 && none.body.result === 1501,
        `(${vReg.body.result}, ${vGet.status}, ${none.body.result})`);

    const bad = async (o) => (await adm('POST', '/rankings', { token: root, body: body(`bad${Math.random().toString(36).slice(2, 8)}`, o) })).body.result;
    const codes = {
        dup: (await adm('POST', '/rankings', { token: root, body: body('weekly') })).body.result,
        bits: await bad({ scoreMax: 2 ** 40, timeUnit: 1 }),
        past: await bad({ startAt: at(-60) }),
        soon: await bad({ startAt: at(30) }),
        tz: await bad({ timezone: 'Mars/Base' }),
        monthly: await bad({ cycleType: 3, startAt: '2027-01-30T00:00:00+09:00' }),
        fixedNoValue: await bad({ cycleType: 4 }),
        endBeforeStart: await bad({ endAt: at(60) }),
        settle: await bad({ cycleType: 1, reviewPeriod: 86400 }),
        tierOrder: await bad({ tiers: [{ tierNo: 1, rangeType: 1, rangeFrom: 5, rangeTo: 1, rewardCode: 'X' }] }),
        tierPercent: await bad({ tiers: [{ tierNo: 1, rangeType: 2, rangeFrom: 1, rangeTo: 101, rewardCode: 'X' }] }),
        tierDup: await bad({ tiers: [{ tierNo: 1, rangeType: 1, rangeFrom: 1, rangeTo: 1, rewardCode: 'X' }, { tierNo: 1, rangeType: 1, rangeFrom: 2, rangeTo: 2, rewardCode: 'Y' }] }),
        latest: await bad({ updateRule: 3 }),
        unknown: await bad({ timeBits: 40 }),
        rule: await bad({ suspicionConfig: { rules: { VELOCTY: { weight: 1, maxPerHour: 10 } } } }),
    };
    const expect = { dup: 1502, bits: 2009, past: 2010, soon: 2010, tz: 2010, monthly: 2010, fixedNoValue: 2010, endBeforeStart: 2010, settle: 2011,
        tierOrder: 2012, tierPercent: 2012, tierDup: 2012, latest: 2001, unknown: 2001, rule: 2001 };
    check('K4 등록 검증: 중복 1502, 비트 2009, 일정 2010, 정산 기간 2011, 구간 2012, 형식·모르는 필드·모르는 탐지 규칙 2001',
        Object.entries(expect).every(([k, v]) => codes[k] === v), JSON.stringify(codes));

    // 시즌 일정 변경 (첫 시즌 시작 전): 시즌을 지우고 스케줄러가 새 정의로 다시 만든다
    const newStart = at(300);
    const sched = await adm('PATCH', `/rankings/${id}`, { token: root, body: { cycleType: 4, cycleValue: 3600, startAt: newStart, reviewPeriod: 600 } });
    const remade = await until(async () => {
        const s = await seasonsOf(id);
        return s.length === 3 && s[0].start === new Date(newStart).getTime() && s.every((x) => x.end - x.start === 3_600_000 && x.parts === 2);
    });
    check('K5 시작 전 일정 변경: 시즌 다시 생성 (새 시작·FIXED 1시간)', sched.status === 200 && remade >= 0, `(${sched.status} ${sched.body.message ?? ''})`);

    const ops = await adm('PATCH', `/rankings/${id}`, { token: root, body: { name: 'RK renamed', maxSubmitPerMin: 200, suspicionConfig: { rules: { REJECTED: { weight: 10 } } } } });
    const immut = await adm('PATCH', `/rankings/${id}`, { token: root, body: { scoreMax: 5 } });
    const empty = await adm('PATCH', `/rankings/${id}`, { token: root, body: {} });
    const [opsRow] = await q('SELECT ranking_name n, max_submit_per_min m, suspicion_config c, score_max s FROM ranking_definition WHERE ranking_id = ?', [id]);
    const paused = await adm('PATCH', `/rankings/${id}`, { token: root, body: { status: 2 } });
    const resumed = await adm('PATCH', `/rankings/${id}`, { token: root, body: { status: 1 } });
    check('K6 운영 값 수정, 불변 필드·빈 바디 2001, PAUSED ↔ ACTIVE',
        ops.status === 200 && ops.body.data?.name === 'RK renamed' && opsRow.m === 200 && opsRow.c?.rules?.REJECTED?.weight === 10 && opsRow.s === 100000000
        && immut.body.result === 2001 && empty.body.result === 2001 && paused.body.data?.status === 2 && resumed.body.data?.status === 1,
        `(${ops.status}, ${immut.body.result}, ${empty.body.result}, ${paused.status}/${resumed.status})`);

    // 진행 중 랭킹 픽스처 (FIXED 600초, 30초 전 시작): 1 OPEN, 2·3 예정
    await createDefinition(IDS.rkShort, { cycleType: 4, cycleValue: 600, startSec: -30 });
    await createDefinition(IDS.rkExtend, { cycleType: 4, cycleValue: 600, startSec: -30, endSec: 100 });
    await createDefinition(IDS.rkOver, { cycleType: 4, cycleValue: 600, startSec: -700, endSec: -5 });
    // rkEnd는 지금 규칙으로는 정산 기간 검증(2011)에 걸리는 기존 정의다(60 + 600 ≥ 600). 검증 값을 바꾸지 않는 수정은 통과해야 한다.
    await createDefinition(IDS.rkEnd, { cycleType: 4, cycleValue: 600, startSec: -30, reviewPeriod: 600 });
    const ready = await until(async () => (await seasonsOf(IDS.rkShort)).length === 3 && (await seasonsOf(IDS.rkEnd)).length === 3
        && (await seasonsOf(IDS.rkExtend)).length === 1 && (await seasonsOf(IDS.rkOver)).length === 2);
    check('K7 픽스처 시즌 준비', ready >= 0);

    const tzRun = await adm('PATCH', `/rankings/${IDS.rkShort}`, { token: root, body: { timezone: 'Asia/Tokyo' } });
    const pastEnd = await adm('PATCH', `/rankings/${IDS.rkShort}`, { token: root, body: { endAt: at(-10) } });
    const shortEnd = at(20);
    const short = await adm('PATCH', `/rankings/${IDS.rkShort}`, { token: root, body: { endAt: shortEnd } });
    const sShort = await seasonsOf(IDS.rkShort);
    const [st] = await q('SELECT TIMESTAMPDIFF(SECOND, end_at, settle_at) d FROM ranking_season WHERE ranking_id = ? AND season_no = 1', [IDS.rkShort]);
    // 빈 파티션은 응답 뒤에 지운다(요청 제한 시간 밖)
    const partsGone = await until(async () => !(await hasSeasonPart('ranking_entry', IDS.rkShort, 2)) && !(await hasSeasonPart('ranking_submit_key', IDS.rkShort, 3)));
    const cur = (await callSp(A, 'SP_GET_CURRENT_SEASON', [IDS.rkShort])).rows[0];
    check('K8 시작 뒤 일정 변경 1503, 지난 시각 1503, 조기 종료: 진행 중 시즌 end_at·settle_at 재계산, 예정 시즌 삭제, 빈 파티션은 응답 뒤 삭제',
        tzRun.body.result === 1503 && pastEnd.body.result === 1503 && short.status === 200 && sShort.length === 1
        && sShort[0].end === new Date(shortEnd).getTime() && st?.d === 60 && partsGone >= 0 && cur?.end_at.getTime() === new Date(shortEnd).getTime(),
        `(${tzRun.body.result}, ${pastEnd.body.result}, ${short.status}, ${JSON.stringify(sShort.map((x) => [x.no, x.status]))}, settle ${st?.d}, parts ${partsGone})`);

    const [s1] = await seasonsOf(IDS.rkExtend);
    const extend = await adm('PATCH', `/rankings/${IDS.rkExtend}`, { token: root, body: { endAt: at(2000) } });
    const sExt = await seasonsOf(IDS.rkExtend);
    const more = await until(async () => (await seasonsOf(IDS.rkExtend)).length === 3);
    check('K9 늘리기: 잘려 있던 시즌을 원래 길이로 되돌리고 스케줄러가 이어서 생성',
        extend.status === 200 && sExt[0].end === s1.start + 600_000 && more >= 0, `(${extend.status} ${extend.body.message ?? ''}, ${JSON.stringify(sExt.map((x) => [x.no, x.end - x.start]))})`);

    const over = await adm('PATCH', `/rankings/${IDS.rkOver}`, { token: root, body: { endAt: at(1000) } });
    check('K10 이미 끝난 랭킹 늘리기 1503', over.body.result === 1503, `(${over.body.result})`);

    const ended = await adm('PATCH', `/rankings/${IDS.rkEnd}`, { token: root, body: { status: 3 } });
    const sEnd = await seasonsOf(IDS.rkEnd);
    const revive = await adm('PATCH', `/rankings/${IDS.rkEnd}`, { token: root, body: { status: 1 } });
    const endMove = await adm('PATCH', `/rankings/${IDS.rkEnd}`, { token: root, body: { endAt: at(100) } });
    const endOps = await adm('PATCH', `/rankings/${IDS.rkEnd}`, { token: root, body: { topSize: 50 } });
    check('K11 ENDED: 예정 시즌 삭제·진행 중 유지, 되돌리기·종료 변경 1503, 운영 값은 허용 (검증에 걸리는 기존 정의도)',
        ended.status === 200 && sEnd.length === 1 && sEnd[0].status === 2 && revive.body.result === 1503 && endMove.body.result === 1503 && endOps.status === 200,
        `(${ended.status}, ${JSON.stringify(sEnd.map((x) => [x.no, x.status]))}, ${revive.body.result}, ${endMove.body.result}, ${endOps.status})`);

    const tiers = [{ tierNo: 1, rangeType: 1, rangeFrom: 1, rangeTo: 3, rewardCode: 'TOP3' }];
    const put = await adm('PUT', `/rankings/${id}/tiers`, { token: root, body: { tiers } });
    const [{ n: afterTiers }] = await q('SELECT COUNT(tier_no) n FROM ranking_reward_tier WHERE ranking_id = ?', [id]);
    const putBad = await adm('PUT', `/rankings/${id}/tiers`, { token: root, body: { tiers: [{ ...tiers[0], rangeFrom: 9 }] } });
    const putNone = await adm('PUT', '/rankings/4000000000/tiers', { token: root, body: { tiers } });
    const putViewer = await adm('PUT', `/rankings/${id}/tiers`, { token: viewer, body: { tiers } });
    check('K12 보상 구간 교체, 규칙 위반 2012, 없는 랭킹 1501, viewer 2003',
        put.status === 200 && afterTiers === 1 && putBad.body.result === 2012 && putNone.body.result === 1501 && putViewer.body.result === 2003,
        `(${put.status}, ${afterTiers}, ${putBad.body.result}, ${putNone.body.result}, ${putViewer.body.result})`);

    const [{ vid }] = await q("SELECT admin_account_id vid FROM admin_account WHERE login_id = 'rtest-rkview'");
    const spIns = await callSp(A, 'SP_INSERT_RANKING_DEFINITION', [vid, `${RK_CODE}sp`, 'x', 1, 1, 1, 100, 2, 46, 'UTC', new Date(Date.now() + 3_600_000), null, 0, null, 0, 0, 0, 100, 0, null, null, null, '[]']);
    const spUpd = await callSp(A, 'SP_UPDATE_RANKING_DEFINITION', [vid, id, 'x', 1, 'UTC', new Date(), null, 0, null, 0, 0, 0, 100, 0, null, null, null, null, null]);
    const spTier = await callSp(A, 'SP_REPLACE_RANKING_REWARD_TIER', [vid, id, '[]']);
    check('K13 SP 역할 재확인: viewer는 등록·수정·구간 교체 1405', spIns.result === 1405 && spUpd.result === 1405 && spTier.result === 1405,
        `(${spIns.result}, ${spUpd.result}, ${spTier.result})`);

    // 스케줄러 락을 테스트가 쥐고 있으면 수정은 3초 기다린 뒤 2013으로 끝나고 반영되지 않는다
    const holder = await A.getConnection();
    try {
        const [[{ got }]] = await holder.query("SELECT GET_LOCK('podium:schedule', 10) got");
        const busy = await adm('PATCH', `/rankings/${id}`, { token: root, body: { name: 'RK busy' } });
        const [{ n: busyName }] = await q('SELECT ranking_name n FROM ranking_definition WHERE ranking_id = ?', [id]);
        check('K14 스케줄러와 겹치면 2013, 반영 안 됨', got === 1 && busy.body.result === 2013 && busy.status === 503 && busyName === 'RK renamed', `(${busy.body.result}, ${busyName})`);
    } finally {
        await holder.query("SELECT RELEASE_LOCK('podium:schedule')");
        holder.release();
    }

    await sleep(300);
    const [{ rid }] = await q("SELECT admin_account_id rid FROM admin_account WHERE login_id = 'rtest-rkroot'");
    const audit = (await LM.query("SELECT action, target_id t, result_code r, before_json b, after_json a FROM log_admin_audit WHERE admin_account_id = ? AND target_type = 'ranking'", [rid]))[0];
    const create = audit.find((x) => x.action === 'ranking.create' && x.t === String(id) && x.r === 0);
    const update = audit.find((x) => x.action === 'ranking.update' && x.t === String(id) && x.r === 0 && x.a?.name === 'RK renamed');
    const tierLog = audit.find((x) => x.action === 'ranking.tiers' && x.r === 0);
    // 실패: SP 거부(1502)와 SP 전에 앱이 거부한 것(검증 2009·2012, 락 2013)
    const failed = [['ranking.create', 1502], ['ranking.create', 2009], ['ranking.update', 1503], ['ranking.update', 2013], ['ranking.tiers', 2012]]
        .filter(([action, r]) => !audit.some((x) => x.action === action && x.r === r));
    check('K15 감사 로그: 등록·수정(변경 전·후)·구간 교체, 앱 검증·락 거부를 포함한 실패도 기록',
        create?.a?.timeBits === 26 && update?.b?.name === 'RK' && tierLog?.b?.tiers?.length === 2 && tierLog?.a?.tiers?.length === 1 && failed.length === 0,
        `(${audit.length}건, 빠짐 ${JSON.stringify(failed)})`);
}

// ------------------------------------------------------------------------------------------------ 실행

/** 구간 하나의 제한 시간. 넘으면 멈춘 것으로 보고 전체를 중단한다 — 결과를 영영 기다리지 않게 한다 */
const SECTION_TIMEOUT_MS = 5 * 60_000;
/** 진행 하트비트 간격 — 로그가 이보다 오래 멈추면 그 자리에서 멈춘 것이다 */
const HEARTBEAT_MS = 30_000;
const t0 = Date.now();
const clock = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
};
let where = '시작 전';
let sectionAt = Date.now();
const heartbeat = setInterval(() => console.log(`${clock()} ... 진행 중: ${where} (${Math.round((Date.now() - sectionAt) / 1000)}s, 통과 ${results.filter(Boolean).length}/${results.length})`), HEARTBEAT_MS);

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
let aborted = null;
try {
    const times = Number(process.argv[2] ?? 3);
    for (let i = 1; i <= times; i++) {
        console.log(`\n${clock()} === run ${i} ===`);
        for (const [name, fn] of [['복구 시나리오', recoveryScenarios], ['락 대기 제한', lockWait], ['API 경유', apiScenarios], ['시즌 스케줄러', schedulerScenarios], ['정산', settlementScenarios], ['보상 전달', deliveryScenarios], ['로그 정리', logCleanupScenarios], ['시즌 백업 분리', archiveScenarios],
            ['관리 API', adminScenarios], ['관리 랭킹', rankingAdminScenarios], ['장애 주입 API', apiFaults], ['장애 주입 워커', workerFaults]].filter(([name]) => !ONLY || name.includes(ONLY))) {
            where = `run ${i} / ${name}`;
            sectionAt = Date.now();
            console.log(`${clock()} -- ${name} 시작`);
            await clean();
            let timer;
            try {
                await Promise.race([fn(), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`구간 시간 초과 ${SECTION_TIMEOUT_MS / 1000}s`)), SECTION_TIMEOUT_MS);
                })]);
            } finally {
                clearTimeout(timer);
                await killAll();
            }
            console.log(`${clock()} -- ${name} 끝 ${Math.round((Date.now() - sectionAt) / 1000)}s`);
        }
    }
} catch (e) {
    // 예외로 끝나도 정리와 요약은 한다. 시간 초과면 구간 함수가 뒤에서 아직 돌 수 있어 마지막에 강제 종료한다.
    aborted = e;
    check(`ABORTED ${where}`, false, e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
} finally {
    clearInterval(heartbeat);
    await killAll();
    await clean();
    await R.close();
    await M.end();
    await A.end();
    await LM.end();
    await LA.end();
}
check('unhandled rejection 없음', unhandled.length === 0, unhandled.map(String).join('; '));
const failed = results.filter((ok) => !ok).length;
console.log(`\n${clock()} ${aborted ? 'ABORTED — ' : ''}${results.length - failed}/${results.length} passed`);
(await import(root + 'core/logger.js')).shutdownLogger();
process.exitCode = failed ? 1 : 0;
if (aborted)
    setTimeout(() => process.exit(1), 1000).unref();
