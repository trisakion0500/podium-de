import { createClient, defineScript } from 'redis';
import type { CommandParser } from 'redis';
import { config } from './config.js';
import { logger } from './logger.js';

/** Redis 반영 실패 시 백그라운드 재시도 간격 (01_DESIGN 6.1 L1). 첫 시도는 응답 전에 한다 */
const RETRY_DELAYS_MS = [100, 400];

/** 제출 빈도 카운터 창 (max_submit_per_min) */
const RATE_WINDOW_MS = 60_000;

/**
 * Lua 스크립트. 클라이언트가 EVALSHA로 보내고 서버에 없으면 EVAL로 대체한다 (D-53).
 * 반영 스크립트는 센티넬(:ready)이 없으면 -1을 돌려주고 쓰지 않는다 — 정산이 지운 키를 늦은 반영이 되살리지 않게 한다 (5.3).
 */
const scripts = {
    /** BEST: composite가 더 좋을 때만 쓴다. DESC는 GT, ASC는 LT. 결과는 바뀐 멤버 수(0/1) */
    applyBest: defineScript({
        NUMBER_OF_KEYS: 2,
        SCRIPT: `if redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
return redis.call('ZADD', KEYS[1], ARGV[1], 'CH', ARGV[2], ARGV[3])`,
        parseCommand(parser: CommandParser, board: string, ready: string, cmp: 'GT' | 'LT', composite: number, member: string) {
            parser.pushKey(board);
            parser.pushKey(ready);
            parser.push(cmp, String(composite), member);
        },
        transformReply: (reply: unknown) => Number(reply),
    }),
    /** SUM: version이 더 클 때만 쓴다. 늦게 도착한 이전 값이 최신 값을 덮지 않게 한다. 결과는 1 반영, 0 이전 값 */
    applyVersioned: defineScript({
        NUMBER_OF_KEYS: 3,
        SCRIPT: `if redis.call('EXISTS', KEYS[3]) == 0 then return -1 end
local cur = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local v = tonumber(ARGV[3])
if v <= cur then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], v)
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1`,
        parseCommand(parser: CommandParser, board: string, ver: string, ready: string, member: string, composite: number, version: number) {
            parser.pushKey(board);
            parser.pushKey(ver);
            parser.pushKey(ready);
            parser.push(member, String(composite), String(version));
        },
        transformReply: (reply: unknown) => Number(reply),
    }),
    /** 제출 빈도 카운터. 첫 증가 때만 만료를 건다 — INCR과 EXPIRE를 따로 보내면 사이에 끊겼을 때 만료 없는 키가 남아 영구 차단된다 */
    hitRateLimit: defineScript({
        NUMBER_OF_KEYS: 1,
        SCRIPT: `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`,
        parseCommand(parser: CommandParser, key: string, windowMs: number) {
            parser.pushKey(key);
            parser.push(String(windowMs));
        },
        transformReply: (reply: unknown) => Number(reply),
    }),
};

/**
 * 스크립트가 등록된 Redis 클라이언트를 만들고 백그라운드로 접속한다. 접속을 기다리지 않는다 —
 * 원장은 MySQL이라 Redis가 없어도 제출은 성공해야 하고, 리컨실러가 나중에 따라잡는다.
 * 오프라인 큐를 끈다: 끊긴 동안 명령이 쌓였다가 늦게 실행되지 않고 즉시 실패한다.
 * 연결 오류는 재접속마다 반복되므로 상태가 바뀔 때만 한 번씩 남긴다.
 * @returns Redis 클라이언트
 * @author trisakion
 */
export function createRedis() {
    const client = createClient({
        url: config.redis.url,
        password: config.redis.password,
        disableOfflineQueue: true,
        scripts,
    });
    let down = false;
    client.on('error', (err) => {
        if (down)
            return;
        down = true;
        logger.warn('redis unavailable — scores are saved to MySQL only until it recovers', err);
    });
    client.on('ready', () => {
        down = false;
        logger.info('redis ready');
    });
    client.connect().catch((err) => logger.error('redis connect aborted', err));
    return client;
}

/**
 * Redis 클라이언트 타입 (스크립트 포함)
 * @author trisakion
 */
export type Redis = ReturnType<typeof createRedis>;

/**
 * 정상 종료 때 Redis 연결을 닫는다. 접속 중이 아니면 재접속 시도를 끊는다.
 * @param client Redis 클라이언트
 * @returns 완료 Promise
 * @author trisakion
 */
export async function closeRedis(client: Redis): Promise<void> {
    if (client.isReady)
        await client.close();
    else if (client.isOpen)
        client.destroy();
}

/**
 * 시즌 순위표 키 (01_DESIGN 5.1). {rankingId} 해시태그로 한 랭킹의 키를 같은 클러스터 슬롯에 둔다.
 * @param rankingId 랭킹 ID
 * @param seasonNo 시즌 번호
 * @returns ZSET, version HASH, 센티넬 키
 * @author trisakion
 */
export function seasonKeys(rankingId: number, seasonNo: number): { board: string; ver: string; ready: string } {
    const board = `${config.redis.keyPrefix}rk:{${rankingId}}:s:${seasonNo}`;
    return { board, ver: `${board}:ver`, ready: `${board}:ready` };
}

/**
 * 명령에 제한 시간을 건다. node-redis는 명령별 타임아웃이 없어 호출부에서 감싼다 (D-53).
 * 시간이 지나도 명령 자체는 취소되지 않지만, 반영 스크립트는 GT/version 비교라 늦게 실행돼도 안전하다.
 * @param work Redis 명령
 * @returns 명령 결과
 */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`redis timeout ${config.redis.timeoutMs}ms`)), config.redis.timeoutMs);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 제출 빈도를 센다 (01_DESIGN 9.1). Redis를 쓸 수 없으면 통과시킨다 — 빈도 검사 때문에 원장 적재를 막지 않는다.
 * @param client Redis 클라이언트
 * @param rankingId 랭킹 ID
 * @param memberId 멤버 ID
 * @param perMin 분당 허용 수
 * @returns 허용 여부
 * @author trisakion
 */
export async function allowSubmit(client: Redis, rankingId: number, memberId: string, perMin: number): Promise<boolean> {
    if (!client.isReady)
        return true;
    // ponytail: 고정 1분 창이라 창 경계에서 최대 2배까지 몰릴 수 있다. 엄밀해야 하면 슬라이딩 창으로 바꾼다.
    try {
        const n = await withTimeout(client.hitRateLimit(`${config.redis.keyPrefix}rk:{${rankingId}}:rl:${memberId}`, RATE_WINDOW_MS));
        return n <= perMin;
    } catch (err) {
        logger.warn(`redis rate limit check failed, allowing ranking=${rankingId}`, err);
        return true;
    }
}

/**
 * Redis 반영 대상 하나
 * @author trisakion
 */
export interface ScoreUpdate {
    rankingId: number;
    seasonNo: number;
    memberId: string;
    /** 01_DESIGN 5.2 composite */
    composite: number;
    /** ranking_entry.version (BEST가 아니면 비교에 쓴다) */
    version: number;
    /** BEST면 ZADD GT/LT, 아니면 version 비교 */
    best: boolean;
    /** BEST의 비교 방향. DESC는 GT, ASC는 LT */
    cmp: 'GT' | 'LT';
}

/**
 * 반영을 한 번 시도한다.
 * @param client Redis 클라이언트
 * @param u 반영 대상
 * @returns 성공 여부 (센티넬이 없어 버린 경우도 성공 — 버리는 것이 의도된 동작이다)
 */
async function tryApply(client: Redis, u: ScoreUpdate): Promise<boolean> {
    const keys = seasonKeys(u.rankingId, u.seasonNo);
    try {
        const r = u.best
            ? await withTimeout(client.applyBest(keys.board, keys.ready, u.cmp, u.composite, u.memberId))
            : await withTimeout(client.applyVersioned(keys.board, keys.ver, keys.ready, u.memberId, u.composite, u.version));
        if (r === -1)
            logger.debug(`redis apply skipped (no sentinel) ${keys.board}`);
        return true;
    } catch (err) {
        logger.warn(`redis apply failed ${keys.board} version=${u.version}`, err);
        return false;
    }
}

/**
 * 제출 결과를 Redis에 반영한다 (01_DESIGN 5.3, 6.1). 첫 시도는 기다리고(제출 직후 순위 조회에 보이도록),
 * 실패하면 응답을 막지 않도록 백그라운드에서 다시 시도한다. 끝내 실패해도 리컨실러(6.2)가 따라잡는다.
 * Redis가 끊긴 상태면 시도하지 않는다 — 요청마다 실패 로그가 쌓이는 대신 연결 상태 로그 하나만 남는다.
 * @param client Redis 클라이언트
 * @param u 반영 대상
 * @returns 첫 시도 완료 Promise (예외를 던지지 않는다)
 * @author trisakion
 */
export async function applyScore(client: Redis, u: ScoreUpdate): Promise<void> {
    if (!client.isReady || await tryApply(client, u))
        return;
    void (async () => {
        for (const delay of RETRY_DELAYS_MS) {
            await new Promise((ok) => setTimeout(ok, delay));
            if (!client.isReady)
                return;
            if (await tryApply(client, u))
                return;
        }
        logger.warn(`redis apply gave up ranking=${u.rankingId} season=${u.seasonNo} version=${u.version} — reconciler will catch up`);
    })();
}
