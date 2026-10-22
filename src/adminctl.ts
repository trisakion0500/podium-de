import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { LOGIN_ID_PATTERN } from './admin/accounts.js';
import { createAuditWriter, type AuditWriter } from './admin/audit.js';
import { generatePassword, hashPassword } from './admin/password.js';
import { AdminRole, SpResult } from './core/codes.js';
import { callSp, createPool } from './core/db.js';
import { logger, shutdownLogger } from './core/logger.js';

const USAGE = [
    '사용법:',
    '  npm run admin -- create --login-id <아이디> --name <이름>    admin 역할 계정을 만들고 초기 비밀번호를 한 번 출력',
    '  npm run admin -- reset-password --login-id <아이디>           비밀번호 초기화(잠금 해제, 세션 모두 종료), 새 초기 비밀번호 출력',
    '',
    '비밀번호는 명령줄로 받지 않는다(셸 기록에 남는다). CLI가 만들어 표준 출력에만 쓴다.',
].join('\n');

/** CLI는 사람 계정이 아니라 SYSTEM(0)으로 실행한다 (개발 컨벤션 5.3). SP의 FN_GET_ADMIN_ROLE이 0을 ADMIN으로 본다 */
const SYSTEM = { id: 0, loginId: 'SYSTEM', role: AdminRole.ADMIN };

/**
 * `--이름 값` 형식 인자를 읽는다.
 * @param args 명령 뒤 인자
 * @param allowed 허용하는 이름
 * @returns 이름 → 값 (형식이 틀리거나 모르는 이름이면 undefined)
 */
function parseFlags(args: string[], allowed: string[]): Record<string, string> | undefined {
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i]?.replace(/^--/, '');
        if (!args[i]?.startsWith('--') || !allowed.includes(name) || args[i + 1] === undefined)
            return undefined;
        flags[name] = args[i + 1];
    }
    return allowed.every((n) => flags[n] !== undefined) ? flags : undefined;
}

/**
 * 초기 비밀번호를 표준 출력에만 쓴다. 로거의 파일 appender를 거치지 않아 원문이 로그 파일에 남지 않는다.
 * @param loginId 아이디
 * @param password 초기 비밀번호
 */
function printPassword(loginId: string, password: string): void {
    process.stdout.write(`\n${loginId} 초기 비밀번호 (다시 볼 수 없으니 지금 전달하세요. 첫 로그인 때 바꿔야 합니다):\n${password}\n\n`);
}

/**
 * admin 계정을 만든다. 첫 admin을 만들 때 쓴다. 이후 계정은 관리 API로 만든다.
 * @param pool 메인 DB 풀
 * @param audit 감사 로그 적재기
 * @param loginId 아이디
 * @param name 표시 이름
 * @returns 성공 여부
 */
async function create(pool: Pool, audit: AuditWriter, loginId: string, name: string): Promise<boolean> {
    if (!new RegExp(LOGIN_ID_PATTERN).test(loginId) || name.trim() === '' || name.length > 64) {
        logger.error('아이디는 영문·숫자·._- 3~64자, 이름은 1~64자여야 합니다.');
        return false;
    }
    const password = generatePassword();
    const { result, rows } = await callSp(pool, 'SP_INSERT_ADMIN_ACCOUNT', [SYSTEM.id, loginId, name, AdminRole.ADMIN, await hashPassword(password)]);
    const id = rows[0]?.admin_account_id;
    audit.write({ actor: SYSTEM, action: 'account.create', targetType: 'account', targetId: id, result,
        after: { loginId, name, role: AdminRole.ADMIN }, requestId: randomUUID(), clientIp: '' });
    if (result !== SpResult.OK) {
        logger.error(result === SpResult.ADMIN_LOGIN_ID_TAKEN ? `이미 있는 아이디입니다: ${loginId}` : `생성 실패 RESULT ${result}`);
        return false;
    }
    logger.info(`created admin_account_id=${id} login_id=${loginId} role=admin`);
    printPassword(loginId, password);
    return true;
}

/**
 * 비밀번호를 초기화한다. 모든 admin이 비밀번호를 잃었거나 잠겼을 때의 복구 경로다.
 * @param pool 메인 DB 풀
 * @param audit 감사 로그 적재기
 * @param loginId 아이디
 * @returns 성공 여부
 */
async function resetPassword(pool: Pool, audit: AuditWriter, loginId: string): Promise<boolean> {
    const { rows: found } = await callSp(pool, 'SP_GET_ADMIN_LOGIN', [loginId]);
    if (!found[0]) {
        logger.error(`없는 아이디입니다: ${loginId}`);
        return false;
    }
    const id = found[0].admin_account_id;
    const password = generatePassword();
    const { result } = await callSp(pool, 'SP_RESET_ADMIN_PASSWORD', [SYSTEM.id, id, await hashPassword(password)]);
    audit.write({ actor: SYSTEM, action: 'account.password_reset', targetType: 'account', targetId: id, result, requestId: randomUUID(), clientIp: '' });
    if (result !== SpResult.OK) {
        logger.error(`초기화 실패 RESULT ${result}`);
        return false;
    }
    logger.info(`reset password admin_account_id=${id} login_id=${loginId}${found[0].status === 1 ? '' : ' (사용중지 계정 — 쓰려면 관리 API로 활성화)'}`);
    printPassword(loginId, password);
    return true;
}

const [command, ...args] = process.argv.slice(2);
let run: ((pool: Pool, audit: AuditWriter) => Promise<boolean>) | undefined;
const createFlags = command === 'create' ? parseFlags(args, ['login-id', 'name']) : undefined;
const resetFlags = command === 'reset-password' ? parseFlags(args, ['login-id']) : undefined;
if (createFlags)
    run = (pool, audit) => create(pool, audit, createFlags['login-id'], createFlags.name);
else if (resetFlags)
    run = (pool, audit) => resetPassword(pool, audit, resetFlags['login-id']);

let ok = false;
if (!run) {
    logger.error(USAGE);
} else {
    // 계정 생성·복구는 운영 작업이라 API 키 CLI와 같이 migrate 계정으로 한다.
    const pool = createPool('MIGRATE');
    const logPool = createPool('MIGRATE', 'LOG');
    const audit = createAuditWriter(logPool);
    try {
        ok = await run(pool, audit);
    } catch (err) {
        logger.error('adminctl failed', err);
    } finally {
        await audit.drain();
        await pool.end();
        await logPool.end();
    }
}
await shutdownLogger();
process.exitCode = ok ? 0 : 1;
