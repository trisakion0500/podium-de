import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'mysql2/promise';
import { ProcessType } from './codes.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { formatInstances, listAliveInstances } from './heartbeat.js';
import type { AliveInstance } from './heartbeat.js';
import { logger, shutdownLogger } from './logger.js';
import { runMigrations } from './migrate.js';

const POLL_INTERVAL_MS = 2000;
const { stopCmd, startCmd, expectApi, expectWorker, timeoutSec } = config.upgrade;

/**
 * 셸 명령을 실행하고 표준 출력·에러·종료 코드를 출력한다.
 * 출력은 파이프가 아니라 임시 파일로 받는다 — 시작 명령이 띄운 백그라운드 프로세스가 출력 핸들을 물려받으면
 * 파이프는 그 프로세스가 끝날 때까지 닫히지 않아 반환되지 않는다(Windows에서 확인). 파일은 셸 종료 즉시 읽을 수 있다.
 * @param label 단계 이름
 * @param command 실행할 셸 명령
 * @returns 없음 (종료 코드 0이 아니거나 타임아웃이면 예외)
 */
function runCommand(label: string, command: string): void {
    logger.info(`[${label}] $ ${command}`);
    const dir = mkdtempSync(join(tmpdir(), 'podium-upgrade-'));
    const outPath = join(dir, 'stdout');
    const errPath = join(dir, 'stderr');
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    const r = spawnSync(command, { shell: true, stdio: ['ignore', outFd, errFd], timeout: timeoutSec * 1000 });
    closeSync(outFd);
    closeSync(errFd);
    const stdout = readFileSync(outPath, 'utf8').trimEnd();
    const stderr = readFileSync(errPath, 'utf8').trimEnd();
    // 출력을 리다이렉트하지 않은 백그라운드 프로세스가 파일을 잡고 있으면(Windows) 지우지 못한다. 임시 디렉터리라 남겨 둔다.
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // 남겨 둔다
    }
    if (stdout)
        logger.info(`[${label}] stdout:\n${stdout}`);
    if (stderr)
        logger.warn(`[${label}] stderr:\n${stderr}`);
    if (r.error)
        throw new Error(`[${label}] 명령 실행 실패: ${r.error.message}`);
    logger.info(`[${label}] exit code ${r.status}`);
    if (r.status !== 0)
        throw new Error(`[${label}] 명령이 종료 코드 ${r.status}로 실패했습니다.`);
}

/**
 * 조건을 만족할 때까지 살아 있는 인스턴스 목록을 주기적으로 조회한다.
 * @param pool 커넥션 풀
 * @param done 목록이 이 조건을 만족하면 대기 종료
 * @returns 마지막으로 조회한 목록과 조건 충족 여부
 */
async function waitFor(pool: Pool, done: (rows: AliveInstance[]) => boolean): Promise<{ ok: boolean; rows: AliveInstance[] }> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
        const rows = await listAliveInstances(pool);
        if (done(rows))
            return { ok: true, rows };
        if (Date.now() >= deadline)
            return { ok: false, rows };
        await sleep(POLL_INTERVAL_MS);
    }
}

/**
 * 중단 패치를 한 번에 실행한다: 중지 → 인스턴스 소멸 대기 → migrate → 기동 → 새 버전 하트비트 확인.
 * migrate의 하트비트·버전 검사는 그대로 적용되므로, 이 스크립트가 그 검사를 우회하지 않는다.
 * @param pool 커넥션 풀
 * @returns 성공 여부
 */
async function upgrade(pool: Pool): Promise<boolean> {
    const version = config.appVersion;
    logger.info(`upgrade to v${version} (expect API ${expectApi}, WORKER ${expectWorker}, timeout ${timeoutSec}s)`);

    runCommand('1/5 stop', stopCmd);

    // 정상 종료한 인스턴스는 행을 바로 지우고, 비정상 종료한 인스턴스는 유효 시간이 지나야 빠진다.
    logger.info('[2/5 wait stop] waiting for heartbeats to disappear');
    const stopped = await waitFor(pool, (rows) => rows.length === 0);
    if (!stopped.ok) {
        logger.error(`[2/5 wait stop] ${timeoutSec}초 안에 모든 인스턴스가 멈추지 않았습니다. 남은 인스턴스:\n${formatInstances(stopped.rows)}`);
        return false;
    }
    logger.info('[2/5 wait stop] no alive instance');

    const applied = await runMigrations(pool);
    logger.info(`[3/5 migrate] ${applied.length ? `applied ${applied.length}: ${applied.join(', ')}` : 'no pending migrations'}`);

    runCommand('4/5 start', startCmd);

    logger.info(`[5/5 wait start] waiting for v${version} heartbeats`);
    const count = (rows: AliveInstance[], type: number): number => rows.filter((r) => r.process_type === type && r.app_version === version).length;
    const started = await waitFor(pool, (rows) => count(rows, ProcessType.API) >= expectApi && count(rows, ProcessType.WORKER) >= expectWorker);
    const summary = `API ${count(started.rows, ProcessType.API)}/${expectApi}, WORKER ${count(started.rows, ProcessType.WORKER)}/${expectWorker}`;
    if (!started.ok) {
        logger.error(`[5/5 wait start] ${timeoutSec}초 안에 새 버전 인스턴스가 모두 뜨지 않았습니다 (${summary}). 현재 인스턴스:\n${formatInstances(started.rows) || '  (없음)'}`);
        return false;
    }
    logger.info(`[5/5 wait start] ${summary}\n${formatInstances(started.rows)}`);
    return true;
}

// 명령이 없으면 아무것도 멈추지 않은 상태에서 중단한다.
if (!stopCmd || !startCmd) {
    logger.error('UPGRADE_STOP_CMD, UPGRADE_START_CMD를 설정해야 합니다. .env.example과 README의 "upgrade" 설정 예시(pm2, 직접 실행)를 참고하세요.');
    await shutdownLogger();
    process.exit(1);
}

const pool = createPool('MIGRATE');
let ok = false;
try {
    ok = await upgrade(pool);
} catch (err) {
    logger.error('upgrade failed', err);
} finally {
    await pool.end();
}
logger.info(ok ? 'upgrade succeeded' : 'upgrade FAILED');
await shutdownLogger();
process.exitCode = ok ? 0 : 1;
