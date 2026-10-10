/**
 * 부하 테스트 (open model: 정해진 도착률로 보내고 지연은 예정 시각부터 잰다 — 서버가 느려져도 부하가 줄지 않게 해
 * coordinated omission을 막는다). 로컬 개발 DB·Redis 전용이다. 운영 DB에 실행하지 않는다.
 *
 * 순서 (프로젝트 루트에서):
 *   npm run build
 *   node loadtest/load.mjs setup                      픽스처: ranking_id 931(BEST DESC), 932(SUM DESC), 센티넬, API 키 2개
 *   (다른 터미널) API_PORT=3100 node dist/api.js     setup 뒤에 기동해야 새 키·랭킹을 바로 읽는다
 *   node loadtest/load.mjs run <kind> <rate> <sec> [members]
 *       kind: best | sum | top | member | mix(제출 best 80% + top 10% + member 10%)
 *   node loadtest/load.mjs verify                     MySQL entry 수와 Redis ZCARD, 제출 이력 수 대조
 *   node loadtest/load.mjs clean                      픽스처·키·Redis 키 삭제
 *
 * API 키 원문은 저장소 밖 OS 임시 폴더(podium-load.keys)에 두고 출력하지 않는다. clean이 지운다.
 * 대상 포트는 LOAD_PORT(기본 3100). 인스턴스가 여럿이면 LOAD_PORT=3100,3101 (INSTANCE_ID를 달리 줘 로그 파일을 나눈다).
 * @author trisakion
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const KEYS = join(tmpdir(), 'podium-load.keys');
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const root = new URL('../dist/', import.meta.url).href;
const IDS = [931, 932];
const [mode, kind, rateArg, secArg, membersArg] = process.argv.slice(2);

/**
 * 픽스처 작업용 DB 풀(migrate 계정)과 Redis 연결을 연다.
 * @returns 풀·클라이언트와 닫기 함수
 */
async function db() {
    const { createPool, callSp } = await import(root + 'core/db.js');
    const { config } = await import(root + 'core/config.js');
    const { createClient } = await import('redis');
    const M = createPool('MIGRATE'), A = createPool('APP'), LM = createPool('MIGRATE', 'LOG');
    const R = createClient({ url: config.redis.url, password: config.redis.password });
    await R.connect();
    const q = async (sql, p = []) => (await M.query(sql, p))[0];
    const close = async () => { await R.close(); await M.end(); await A.end(); await LM.end(); (await import(root + 'core/logger.js')).shutdownLogger(); };
    return { M, A, LM, R, q, callSp, config, close };
}

/**
 * 부하 테스트 픽스처를 모두 지운다. 파티션까지 내려 테스트 전 상태로 돌린다.
 * @param d db()의 반환값
 * @returns 없음
 */
async function clean(d) {
    const { q, LM, R, config } = d;
    for (const t of ['ranking_entry', 'ranking_submit_key']) {
        await q(`DELETE FROM ${t} WHERE ranking_id IN (?)`, [IDS]);
        for (const id of IDS) {
            const ps = (await q(`SELECT PARTITION_NAME n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_DESCRIPTION LIKE ?`, [t, `(${id},%`])).map((x) => '`' + x.n + '`');
            if (ps.length)
                await q(`ALTER TABLE ${t} DROP PARTITION ${ps.join(', ')}`);
        }
    }
    await q('DELETE FROM ranking_season WHERE ranking_id IN (?)', [IDS]);
    await q('DELETE FROM ranking_definition WHERE ranking_id IN (?)', [IDS]);
    // 워커 복구 잡이 남긴 동기화 시각·점검 시각도 픽스처의 일부다.
    await q('DELETE FROM job_state WHERE ranking_id IN (?)', [IDS]);
    await q("DELETE FROM api_credential WHERE key_name LIKE 'load-%'");
    await LM.query('DELETE FROM log_ranking_submit WHERE ranking_id IN (?)', [IDS]);
    for (const id of IDS)
        for await (const keys of R.scanIterator({ MATCH: `${config.redis.keyPrefix}rk:{${id}}*`, COUNT: 1000 }))
            if (keys.length)
                await R.del(keys);
    if (existsSync(KEYS))
        rmSync(KEYS);
}

if (mode === 'setup' || mode === 'clean' || mode === 'verify') {
    const d = await db();
    try {
        if (mode === 'clean')
            await clean(d);
        if (mode === 'setup') {
            await clean(d);
            const { q, A, M, R, callSp } = d;
            const { hashApiKey } = await import(root + 'api/auth.js');
            const { seasonKeys } = await import(root + 'core/redis.js');
            const { ApiScope } = await import(root + 'core/codes.js');
            // update_rule 1=BEST 2=SUM, sort 1=DESC. score_max 8000: time_bits 40이면 score × 2^40이 2^53 안에 들어야 한다.
            // cycle_type 0(반복 없음), end_at NULL: 영구 랭킹이라 워커 스케줄러가 시즌을 더 만들지 않는다
            for (const [id, rule] of [[931, 1], [932, 2]]) {
                await q(`INSERT INTO ranking_definition (ranking_id, ranking_code, ranking_name, status, update_rule, sort_order, score_max, time_unit, time_bits,
                          timezone, start_at, end_at, cycle_type, settle_delay, review_period, history_retention, max_delta, max_submit_per_min, created_at, updated_at)
                         VALUES (?, ?, 'load', 1, ?, 1, 8000, 1, 40, 'UTC', NOW(3), NULL, 0, 60, 60, 30, NULL, NULL, NOW(3), NOW(3))`, [id, `LOAD${id}`, rule]);
                await q(`INSERT INTO ranking_season (ranking_id, season_no, start_at, end_at, settle_at, status)
                         VALUES (?, 1, NOW(3) - INTERVAL 1 HOUR, NOW(3) + INTERVAL 3 HOUR, NOW(3) + INTERVAL 4 HOUR, 2)`, [id]);
                await callSp(A, 'SP_PARTITION_ADD', [id, 1]);
                await R.set(seasonKeys(id, 1).ready, '1');
            }
            const mk = async (name, scopes) => { const k = randomBytes(32).toString('base64url'); await callSp(M, 'SP_INSERT_API_CREDENTIAL', [name, hashApiKey(k), scopes]); return k; };
            // 소유자만 읽게 만들고, clean이 지운 뒤라 이미 있으면(누가 미리 만든 파일) 쓰지 않고 실패한다
            writeFileSync(KEYS, JSON.stringify({ w: await mk('load-write', ApiScope.WRITE), r: await mk('load-read', ApiScope.READ) }), { mode: 0o600, flag: 'wx' });
            console.log('setup done');
        }
        if (mode === 'verify') {
            const { q, LM, R } = d;
            // 커밋마다 fsync하는지에 따라 처리량이 크게 달라져 결과와 함께 남긴다
            const vars = await q("SHOW VARIABLES WHERE Variable_name IN ('innodb_flush_log_at_trx_commit', 'sync_binlog', 'log_bin')");
            console.log(vars.map((v) => `${v.Variable_name}=${v.Value}`).join(' '));
            const { seasonKeys } = await import(root + 'core/redis.js');
            for (const id of IDS) {
                const [{ n, s }] = await q('SELECT COUNT(*) n, COALESCE(SUM(score), 0) s FROM ranking_entry WHERE ranking_id = ?', [id]);
                const [{ k }] = await q('SELECT COUNT(*) k FROM ranking_submit_key WHERE ranking_id = ?', [id]);
                const zkey = seasonKeys(id, 1).board;
                const z = await R.zCard(zkey);
                const [[{ lg, rj }]] = await LM.query('SELECT COUNT(*) lg, SUM(rejected IS NOT NULL) rj FROM log_ranking_submit WHERE ranking_id = ?', [id]);
                console.log(`ranking ${id}: entry=${n} sumScore=${s} submitKey=${k} redisZcard=${z} log=${lg} rejected=${rj ?? 0} ${Number(n) === z ? 'OK' : 'MISMATCH'}`);
            }
        }
    } finally {
        await d.close();
    }
} else if (mode === 'run') {
    const keys = JSON.parse(readFileSync(KEYS, 'utf8'));
    const rate = Number(rateArg), sec = Number(secArg), members = Number(membersArg ?? 100000);
    // 여러 인스턴스면 LOAD_PORT=3100,3101처럼 주고 요청마다 번갈아 보낸다 (로드밸런서 대신)
    const ports = (process.env.LOAD_PORT ?? '3100').split(',').map(Number);
    const d = await db();
    const STATS = ['Com_commit', 'Innodb_data_fsyncs', 'Innodb_os_log_fsyncs', 'Innodb_row_lock_waits', 'Innodb_row_lock_time'];
    const status = async () => Object.fromEntries((await d.q('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [STATS])).map((v) => [v.Variable_name, Number(v.Value)]));
    const before = await status();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
    const total = Math.round(rate * sec);
    const lat = new Float64Array(total);
    const codes = new Map();
    let sent = 0, done = 0, inflight = 0, maxInflight = 0, dropped = 0, netErr = 0;
    const tag = randomBytes(4).toString('hex');
    const pick = () => {
        if (kind !== 'mix')
            return kind;
        const x = Math.random();
        return x < 0.8 ? 'best' : x < 0.9 ? 'top' : 'member';
    };
    const req = (i, k) => {
        const m = 'm' + Math.floor(Math.random() * members);
        if (k === 'best' || k === 'sum') {
            const body = JSON.stringify({ memberId: m, value: k === 'sum' ? 1 : Math.floor(Math.random() * 8000), seasonNo: 1, requestId: `${tag}-${i}` });
            return { method: 'POST', path: `/v1/rankings/${k === 'sum' ? 932 : 931}/scores`, key: keys.w, body };
        }
        if (k === 'top')
            return { method: 'GET', path: `/v1/rankings/931/top?size=20&memberId=${m}`, key: keys.r };
        return { method: 'GET', path: `/v1/rankings/931/members/${m}`, key: keys.r };
    };
    const fire = (i, due) => {
        if (inflight >= 4000) {
            dropped++; done++;
            return;
        }
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        const r = req(i, pick());
        const headers = { 'x-api-key': r.key };
        if (r.body)
            headers['content-type'] = 'application/json';
        const h = http.request({ host: '127.0.0.1', port: ports[i % ports.length], method: r.method, path: r.path, agent, headers }, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                lat[i] = performance.now() - due;
                let result = '?';
                try { result = JSON.parse(buf).result; } catch { }
                const c = `${res.statusCode}/${result}`;
                codes.set(c, (codes.get(c) ?? 0) + 1);
                inflight--; done++;
            });
        });
        h.on('error', () => { netErr++; inflight--; done++; lat[i] = NaN; });
        h.end(r.body);
    };
    const start = performance.now() + 50;
    const interval = 1000 / rate;
    await new Promise((resolve) => {
        const tick = () => {
            const now = performance.now();
            while (sent < total && start + sent * interval <= now) {
                fire(sent, start + sent * interval);
                sent++;
            }
            if (sent < total)
                setImmediate(tick);
            else
                resolve();
        };
        tick();
    });
    const sendEnd = performance.now();
    while (done < total)
        await new Promise((r) => setTimeout(r, 20));
    const elapsed = (performance.now() - start) / 1000;
    const ok = Array.from(lat).filter((x) => !Number.isNaN(x) && x > 0).sort((a, b) => a - b);
    const p = (x) => ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * x))].toFixed(1) : '-';
    const after = await status();
    await d.close();
    // 초당 값으로 바꿔 인스턴스 수가 달라도 비교할 수 있게 한다
    const dbRate = Object.fromEntries(STATS.map((k) => [k, Math.round((after[k] - before[k]) / elapsed)]));
    console.log(JSON.stringify({
        kind, ports: ports.length, targetRate: rate, sec, members, sent: total, achievedRate: Math.round(ok.length / elapsed), dbPerSec: dbRate, sendLagMs: Math.round(sendEnd - (start + total * interval)),
        p50: p(0.5), p95: p(0.95), p99: p(0.99), max: ok.length ? ok[ok.length - 1].toFixed(1) : '-', maxInflight, dropped, netErr, codes: Object.fromEntries(codes),
    }));
    agent.destroy();
} else {
    console.log('usage: setup | run <kind> <rate> <sec> [members] | verify | clean');
}
