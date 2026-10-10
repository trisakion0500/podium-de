import { createClient, defineScript } from 'redis';
import type { CommandParser } from 'redis';
import { ApiResult } from './codes.js';
import { config } from './config.js';
import { BusinessException } from './errors.js';
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
    /**
     * SUM: version이 더 클 때만 쓴다. 늦게 도착한 이전 값이 최신 값을 덮지 않게 한다. 결과는 1 반영, 0 이전 값.
     * 리컨실러는 같은 version도 쓴다(ARGV[4] = '1') — MySQL에서 방금 읽은 현재 행이라, version HASH만 남고 ZSET 멤버가
     * 빠진 경우에도 고칠 수 있어야 한다. 더 큰 version이 이미 있으면 그대로 거부된다.
     */
    applyVersioned: defineScript({
        NUMBER_OF_KEYS: 3,
        SCRIPT: `if redis.call('EXISTS', KEYS[3]) == 0 then return -1 end
local cur = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local v = tonumber(ARGV[3])
if v < cur or (v == cur and ARGV[4] ~= '1') then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], v)
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1`,
        parseCommand(parser: CommandParser, board: string, ver: string, ready: string, member: string, composite: number, version: number, allowEqual: boolean) {
            parser.pushKey(board);
            parser.pushKey(ver);
            parser.pushKey(ready);
            parser.push(member, String(composite), String(version), allowEqual ? '1' : '0');
        },
        transformReply: (reply: unknown) => Number(reply),
    }),
    /**
     * 재구축 교체 (01_DESIGN 6.3, D-60). 임시 키를 라이브 키로 바꾸고 센티넬을 세우는 것을 한 번에 한다 —
     * 교체와 센티넬 사이에 버려지는 반영도, 반쯤 바뀐 채 남는 상태도 없다. 임시 키가 없으면(빈 시즌, BEST의 version HASH)
     * 라이브 키만 지운다. 같은 {rankingId} 해시태그라 클러스터에서도 한 슬롯이다.
     * 기존 라이브 키는 UNLINK로 먼저 뗀다 — RENAME이 덮어쓰며 지우면 동기 해제라 100만 명 키에서 Redis 전체가 약 200ms 멈췄다.
     * UNLINK는 큰 값의 해제를 백그라운드 스레드로 넘기므로 lazyfree 설정과 무관하다.
     * 임시 ZSET이 적재한 멤버 수(ARGV[2])보다 작으면 교체하지 않고 0을 돌려준다 — 재구축 도중 Redis가 재시작·페일오버돼
     * 앞 청크를 잃은 임시 키를 라이브로 올리지 않게 한다. 멤버는 PK라 중복이 없어 정상이면 적재 수 이상이다.
     * 센티넬 값은 반영 시각 T(ms)다 (readSentinel 참고).
     */
    swapRebuild: defineScript({
        NUMBER_OF_KEYS: 5,
        SCRIPT: `if redis.call('ZCARD', KEYS[4]) < tonumber(ARGV[2]) then return 0 end
redis.call('UNLINK', KEYS[1], KEYS[2])
if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('RENAME', KEYS[4], KEYS[1]) end
if redis.call('EXISTS', KEYS[5]) == 1 then redis.call('RENAME', KEYS[5], KEYS[2]) end
redis.call('SET', KEYS[3], ARGV[1])
return 1`,
        parseCommand(parser: CommandParser, board: string, ver: string, ready: string, rebuild: string, rebuildVer: string, syncedAt: number, minMembers: number) {
            parser.pushKey(board);
            parser.pushKey(ver);
            parser.pushKey(ready);
            parser.pushKey(rebuild);
            parser.pushKey(rebuildVer);
            parser.push(String(syncedAt), String(minMembers));
        },
        transformReply: (reply: unknown) => Number(reply),
    }),
    /**
     * 순위 조회 (01_DESIGN 5.4). 상위 페이지와 한 멤버의 순위를 한 번에 읽는다. 센티넬이 없으면 -1 — 재구축 중이거나 준비 전이라
     * 일부만 찬 순위표를 내보내지 않는다. 결과는 [상위(member, score 교대), 내 순위 0부터(-1: 없음), 내 score]
     */
    readBoard: defineScript({
        NUMBER_OF_KEYS: 2,
        SCRIPT: `if redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
local off = tonumber(ARGV[2])
local top = {}
if tonumber(ARGV[3]) > 0 then
    if ARGV[1] == 'REV' then
        top = redis.call('ZRANGE', KEYS[1], off, off + ARGV[3] - 1, 'REV', 'WITHSCORES')
    else
        top = redis.call('ZRANGE', KEYS[1], off, off + ARGV[3] - 1, 'WITHSCORES')
    end
end
local rank = false
if ARGV[4] ~= '' then
    rank = redis.call(ARGV[1] == 'REV' and 'ZREVRANK' or 'ZRANK', KEYS[1], ARGV[4])
end
if not rank then return {top, -1, ''} end
return {top, rank, redis.call('ZSCORE', KEYS[1], ARGV[4])}`,
        parseCommand(parser: CommandParser, board: string, ready: string, dir: 'REV' | 'FWD', offset: number, size: number, member: string) {
            parser.pushKey(board);
            parser.pushKey(ready);
            parser.push(dir, String(offset), String(size), member);
        },
        transformReply: (reply: unknown) => reply as -1 | [string[], number, string],
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
 * @returns ZSET, version HASH, 센티넬, 재구축 임시 키 (01_DESIGN 6.3)
 * @author trisakion
 * @modified 2026-10-09 trisakion 재구축 임시 키 추가
 */
export function seasonKeys(rankingId: number, seasonNo: number): SeasonKeys {
    const board = `${config.redis.keyPrefix}rk:{${rankingId}}:s:${seasonNo}`;
    return { board, ver: `${board}:ver`, ready: `${board}:ready`, rebuild: `${board}:rebuild`, rebuildVer: `${board}:rebuild:ver` };
}

/**
 * 한 시즌의 Redis 키
 * @author trisakion
 */
export interface SeasonKeys {
    /** 순위표 ZSET */
    board: string;
    /** member별 version HASH (SUM) */
    ver: string;
    /** 쓰기 허용 센티넬 */
    ready: string;
    /** 재구축 임시 ZSET */
    rebuild: string;
    /** 재구축 임시 version HASH */
    rebuildVer: string;
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
 * 순위표 조회 결과. score는 composite 그대로다 (rankings.decodeScore로 꺼낸다)
 * @author trisakion
 */
export interface BoardRead {
    /** 상위 페이지 (순위 순) */
    top: { memberId: string; composite: number }[];
    /** 요청한 멤버 (멤버를 지정하지 않았거나 순위표에 없으면 null) */
    me: { rank: number; composite: number } | null;
}

/**
 * 현재 시즌 순위표를 읽는다 (01_DESIGN 5.4). 상위 페이지와 내 순위를 스크립트 한 번으로 읽는다.
 * 센티넬이 없거나(재구축 중, 준비 전) Redis를 쓸 수 없으면 2007로 거부한다 — 현재 시즌 순위의 출처는 Redis뿐이다(8.5).
 * @param client Redis 클라이언트
 * @param q 순위표, 정렬 방향(DESC는 REV), 페이지, 멤버('' 이면 생략)
 * @returns 상위 페이지와 내 순위 (순위는 1부터)
 * @author trisakion
 */
export async function readBoard(client: Redis, q: {
    rankingId: number; seasonNo: number; rev: boolean; offset: number; size: number; memberId: string;
}): Promise<BoardRead> {
    if (!client.isReady)
        throw new BusinessException(ApiResult.RANKING_UNAVAILABLE, 'redis not ready');
    const keys = seasonKeys(q.rankingId, q.seasonNo);
    let reply: -1 | [string[], number, string];
    try {
        // node-redis 반환 타입이 튜플을 배열로 넓혀서 다시 좁힌다.
        reply = await withTimeout(client.readBoard(keys.board, keys.ready, q.rev ? 'REV' : 'FWD', q.offset, q.size, q.memberId)) as typeof reply;
    } catch (err) {
        logger.warn(`redis read failed ${keys.board}`, err);
        throw new BusinessException(ApiResult.RANKING_UNAVAILABLE, 'redis read failed');
    }
    if (reply === -1)
        throw new BusinessException(ApiResult.RANKING_UNAVAILABLE, `no sentinel ${keys.ready}`);
    const [flat, rank, score] = reply;
    const top: BoardRead['top'] = [];
    for (let i = 0; i < flat.length; i += 2)
        top.push({ memberId: flat[i], composite: Number(flat[i + 1]) });
    return { top, me: rank < 0 ? null : { rank: rank + 1, composite: Number(score) } };
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
 * 센티넬 확인 Lua로 라이브 키에 반영한다 (01_DESIGN 5.3).
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @param u 반영 대상
 * @param allowEqual SUM에서 같은 version도 쓸지 (리컨실러만 true)
 * @returns -1 센티넬 없음, 0 거부(이전 값), 1 이상 반영
 */
async function applyLive(client: Redis, keys: SeasonKeys, u: ScoreUpdate, allowEqual: boolean): Promise<number> {
    return u.best
        ? withTimeout(client.applyBest(keys.board, keys.ready, u.cmp, u.composite, u.memberId))
        : withTimeout(client.applyVersioned(keys.board, keys.ver, keys.ready, u.memberId, u.composite, u.version, allowEqual));
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
        const r = await applyLive(client, keys, u, false);
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

/**
 * 시즌 센티넬을 읽는다. 복구 잡은 이것으로 L2(있음)와 L3 재구축(없음)을 고른다 (01_DESIGN 6.2, 6.3).
 * 값은 이 Redis가 마지막으로 따라잡은 DB 시각 T(ms)다. RDB 스냅샷 복원이나 레플리카 페일오버로 Redis가 과거로 돌아가면
 * 센티넬 값도 함께 돌아가므로, L2가 DB 동기화 시각(job_state.synced_at) 대신 이 값부터 읽어 빠진 구간을 다시 채운다.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @returns 따라잡은 시각 ms (센티넬 없음: null)
 * @author trisakion
 * @modified 2026-10-09 trisakion hasSentinel → readSentinel, 센티넬 값에 따라잡은 시각을 담음
 */
export async function readSentinel(client: Redis, keys: SeasonKeys): Promise<number | null> {
    const v = await withTimeout(client.get(keys.ready));
    // 이전 버전이 남긴 '1'은 1ms, 숫자가 아니면 0 — 둘 다 처음부터 다시 읽는다.
    return v === null ? null : Number(v) || 0;
}

/**
 * L2를 끝까지 마친 뒤 센티넬 값을 따라잡은 시각으로 바꾼다. 센티넬이 있을 때만 쓴다(XX) — 그 사이 정산이 지웠거나
 * Redis 유실로 사라진 센티넬을 되살리지 않는다.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @param syncedAt 따라잡은 DB 시각 T
 * @returns 완료 Promise
 * @author trisakion
 */
export async function markSynced(client: Redis, keys: SeasonKeys, syncedAt: Date): Promise<void> {
    await withTimeout(client.set(keys.ready, String(syncedAt.getTime()), { condition: 'XX' }));
}

/**
 * 멤버들의 현재 composite를 한 번에 읽는다 (ZMSCORE).
 * @param client Redis 클라이언트
 * @param board 순위표 키
 * @param members 멤버 ID 목록 (1개 이상)
 * @returns 멤버 순서대로 composite (없으면 null)
 * @author trisakion
 */
export async function readComposites(client: Redis, board: string, members: string[]): Promise<(number | null)[]> {
    const reply = await withTimeout(client.zmScore(board, members));
    return reply.map((v) => (v === null ? null : Number(v)));
}

/**
 * 리컨실러 반영. API 반영과 같은 센티넬 확인 Lua를 쓴다 — 정산이 지운 키를 되살리지 않는다 (01_DESIGN 6.2).
 * SUM은 같은 version도 쓴다: MySQL에서 방금 읽은 현재 행이라 더 새로운 값이 아니면 덮어도 맞다.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @param u 반영 대상
 * @returns -1 센티넬 없음, 0 거부(Redis가 더 새 값), 1 이상 반영. 실패는 예외
 * @author trisakion
 */
export async function reconcileScore(client: Redis, keys: SeasonKeys, u: ScoreUpdate): Promise<number> {
    return applyLive(client, keys, u, true);
}

/**
 * 재구축 임시 키에 행을 쓴다 (01_DESIGN 6.3). 센티넬을 보지 않는다 — 라이브 키가 아니라서 정산 삭제와 무관하다.
 * 비교 없이 덮어쓴다: 적재와 따라잡기가 한 워커에서 순서대로 실행되고 나중에 읽은 행이 더 새 값이다.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @param items 멤버, composite, version
 * @param withVersion version HASH도 쓸지 (BEST는 라이브에서 version을 쓰지 않아 false)
 * @returns 완료 Promise
 * @author trisakion
 */
export async function writeRebuild(client: Redis, keys: SeasonKeys, items: { memberId: string; composite: number; version: number }[], withVersion: boolean): Promise<void> {
    if (items.length === 0)
        return;
    const writes: Promise<unknown>[] = [client.zAdd(keys.rebuild, items.map((i) => ({ score: i.composite, value: i.memberId })))];
    if (withVersion)
        writes.push(client.hSet(keys.rebuildVer, Object.fromEntries(items.map((i) => [i.memberId, String(i.version)]))));
    await withTimeout(Promise.all(writes));
}

/**
 * 이전에 중단된 재구축의 임시 키를 지운다.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @returns 완료 Promise
 * @author trisakion
 */
export async function clearRebuild(client: Redis, keys: SeasonKeys): Promise<void> {
    // 중단된 재구축의 임시 키도 수십만 개일 수 있어 비동기 해제한다.
    await withTimeout(client.unlink([keys.rebuild, keys.rebuildVer]));
}

/**
 * 재구축을 마친다: 임시 키를 라이브 키로 바꾸고 센티넬을 세운다 (swapRebuild Lua, D-60).
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @param syncedAt 따라잡은 DB 시각 T (센티넬 값)
 * @param minMembers 적재한 멤버 수. 임시 ZSET이 이보다 작으면 교체하지 않는다
 * @returns 교체 여부 (false: 임시 키 일부 유실 — Redis 재시작·페일오버)
 * @author trisakion
 * @modified 2026-10-09 trisakion 센티넬 값에 따라잡은 시각, 임시 키 유실 시 교체 거부
 */
export async function finishRebuild(client: Redis, keys: SeasonKeys, syncedAt: Date, minMembers: number): Promise<boolean> {
    return await withTimeout(client.swapRebuild(keys.board, keys.ver, keys.ready, keys.rebuild, keys.rebuildVer, syncedAt.getTime(), minMembers)) === 1;
}

/**
 * 정산이 끝난 시즌의 키를 모두 지운다 (01_DESIGN 5.6). 센티넬, 순위표, version HASH, 재구축 임시 키를 UNLINK 한 번으로 지운다 —
 * 한 명령이라 센티넬만 남거나 순위표만 남는 순간이 없고, 큰 ZSET은 백그라운드 스레드가 해제해 Redis가 멈추지 않는다(1.7).
 * 센티넬이 사라진 뒤 늦게 도착한 반영은 센티넬 확인 Lua가 버린다(5.3). 호출자는 복구 잡 락을 쥐고 부른다(D-60).
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @returns 완료 Promise
 * @author trisakion
 */
export async function deleteSeasonKeys(client: Redis, keys: SeasonKeys): Promise<void> {
    await withTimeout(client.unlink([keys.ready, keys.board, keys.ver, keys.rebuild, keys.rebuildVer]));
}

/**
 * 보조 점검(01_DESIGN 6.4)용 순위표 멤버 수.
 * @param client Redis 클라이언트
 * @param keys 시즌 키
 * @returns ZCARD
 * @author trisakion
 */
export async function countBoard(client: Redis, keys: SeasonKeys): Promise<number> {
    return withTimeout(client.zCard(keys.board));
}
