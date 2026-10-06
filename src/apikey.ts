import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { ApiScope, SpResult } from './codes.js';
import { createPool, callSp } from './db.js';
import { logger, shutdownLogger } from './logger.js';

const USAGE = [
    '사용법:',
    '  npm run credential -- create <이름> <권한>   권한: write,read,reward 중 쉼표로 조합',
    '  npm run credential -- revoke <ID>',
    '  npm run credential -- list [--all]           --all: 폐기된 키 포함',
].join('\n');

const SCOPE_NAMES: Record<string, number> = { write: ApiScope.WRITE, read: ApiScope.READ, reward: ApiScope.REWARD };

/**
 * 권한 비트를 이름 목록으로 바꾼다.
 * @param scopes 권한 비트
 * @returns 예: "write,read"
 */
function scopeText(scopes: number): string {
    return Object.entries(SCOPE_NAMES).filter(([, bit]) => scopes & bit).map(([name]) => name).join(',');
}

/**
 * 키를 발급한다. 키는 32바이트 난수(base64url 43자)이며 DB에는 SHA-256 해시만 저장한다 (01_DESIGN 10.1).
 * 원문은 여기서 한 번만 보여준다.
 * @param pool 커넥션 풀
 * @param name 키 이름
 * @param scopeArg 쉼표로 구분한 권한 이름
 * @returns 성공 여부
 */
async function create(pool: Pool, name: string, scopeArg: string): Promise<boolean> {
    let scopes = 0;
    for (const s of scopeArg.split(',')) {
        const bit = SCOPE_NAMES[s.trim().toLowerCase()];
        if (!bit) {
            logger.error(`알 수 없는 권한: ${s}\n${USAGE}`);
            return false;
        }
        scopes |= bit;
    }
    const key = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(key).digest();
    const { result, rows } = await callSp(pool, 'SP_INSERT_API_CREDENTIAL', [name, hash, scopes]);
    if (result !== SpResult.OK) {
        logger.error(`발급 실패 RESULT ${result} (이름은 1~64자, 권한은 하나 이상)`);
        return false;
    }
    logger.info(`issued api_credential_id=${rows[0].api_credential_id} name=${name} scopes=${scopeText(scopes)}`);
    // 키 원문은 로거를 거치지 않고 표준 출력에만 쓴다 — 로거의 파일 appender가 원문을 로그 파일에 남기지 않게 한다.
    process.stdout.write(`\nAPI 키 (다시 볼 수 없으니 지금 보관하세요):\n${key}\n\n모든 API 인스턴스에서 통과하기까지 최대 30초가 걸립니다.\n`);
    return true;
}

/**
 * 키를 폐기한다. API는 다음 재조회(최대 30초) 때 반영한다. 즉시 막아야 하면 폐기 후 API를 재시작한다.
 * @param pool 커넥션 풀
 * @param idArg 키 ID
 * @returns 성공 여부 (이미 폐기된 키도 성공으로 본다)
 */
async function revoke(pool: Pool, idArg: string): Promise<boolean> {
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) {
        logger.error(`ID는 양의 정수여야 합니다: ${idArg}`);
        return false;
    }
    const { result } = await callSp(pool, 'SP_REVOKE_API_CREDENTIAL', [id]);
    if (result === SpResult.CREDENTIAL_ALREADY_REVOKED) {
        logger.info(`api_credential_id=${id} is already revoked`);
        return true;
    }
    if (result !== SpResult.OK) {
        logger.error(result === SpResult.CREDENTIAL_NOT_FOUND ? `api_credential_id=${id} 키가 없습니다.` : `폐기 실패 RESULT ${result}`);
        return false;
    }
    logger.info(`revoked api_credential_id=${id}. 즉시 차단이 필요하면 API를 재시작하세요(아니면 최대 30초 후 반영).`);
    return true;
}

/**
 * 키 목록을 출력한다. 해시는 출력하지 않는다.
 * @param pool 커넥션 풀
 * @param includeRevoked 폐기된 키 포함 여부
 * @returns 성공 여부
 */
async function list(pool: Pool, includeRevoked: boolean): Promise<boolean> {
    const { result, rows } = await callSp(pool, 'SP_LIST_API_CREDENTIAL', [includeRevoked ? 1 : 0]);
    if (result !== SpResult.OK) {
        logger.error(`목록 조회 실패 RESULT ${result}`);
        return false;
    }
    const lines = rows.map((r) =>
        `  ${r.api_credential_id}\t${r.key_name}\t${scopeText(r.scopes)}\tcreated ${r.created_at.toISOString()}${r.revoked_at ? `\trevoked ${r.revoked_at.toISOString()}` : ''}`);
    logger.info(`api credentials (${rows.length}):\n${lines.join('\n') || '  (없음)'}`);
    return true;
}

const [command, ...args] = process.argv.slice(2);
let run: ((pool: Pool) => Promise<boolean>) | undefined;
if (command === 'create' && args.length === 2)
    run = (pool) => create(pool, args[0], args[1]);
else if (command === 'revoke' && args.length === 1)
    run = (pool) => revoke(pool, args[0]);
else if (command === 'list' && (args.length === 0 || (args.length === 1 && args[0] === '--all')))
    run = (pool) => list(pool, args.length === 1);

let ok = false;
if (!run) {
    logger.error(USAGE);
} else {
    // 발급·폐기는 운영 작업이라 API·워커 호스트에 있는 앱 계정이 아니라 migrate 계정으로 한다.
    const pool = createPool('MIGRATE');
    try {
        ok = await run(pool);
    } catch (err) {
        logger.error('apikey failed', err);
    } finally {
        await pool.end();
    }
}
await shutdownLogger();
process.exitCode = ok ? 0 : 1;
