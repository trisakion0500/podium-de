import { bootstrap } from './core/bootstrap.js';
import { ProcessType } from './core/codes.js';
import { createPool } from './core/db.js';
import { logger } from './core/logger.js';
import { startRankingRefresh } from './core/rankings.js';
import { closeRedis, createRedis } from './core/redis.js';
import { startDelivery } from './worker/delivery.js';
import { startLogCleanup, startLogCleanupWatch } from './worker/logcleanup.js';
import { startRecovery } from './worker/recovery.js';
import { startScheduler } from './worker/scheduler.js';
import { startSettlement } from './worker/settle.js';

const { pool, onShutdown } = await bootstrap('worker', ProcessType.WORKER);
const redis = createRedis();
// 로그 정리 잡 전용. 메인 풀과 나눠 로그 DB 장애가 메인 커넥션을 붙잡지 않게 한다 (D-48).
const logPool = createPool('APP', 'LOG');

let stopRecovery: (() => Promise<void>) | undefined;
let stopScheduler: (() => Promise<void>) | undefined;
let stopSettlement: (() => Promise<void>) | undefined;
let stopDelivery: (() => Promise<void>) | undefined;
let stopLogCleanup: (() => Promise<void>) | undefined;
let stopLogCleanupWatch: (() => Promise<void>) | undefined;
let stopRefresh: (() => void) | undefined;
// 잡을 먼저 멈춘 뒤 정의 재조회, Redis, 로그 DB 풀 순으로 닫는다. 메인 DB 풀은 bootstrap이 마지막에 닫는다 (개발 컨벤션 5.2).
const shutdown = onShutdown(async () => {
    await Promise.all([stopRecovery?.(), stopScheduler?.(), stopSettlement?.(), stopDelivery?.(), stopLogCleanup?.(), stopLogCleanupWatch?.()]);
    stopRefresh?.();
    await closeRedis(redis);
    await logPool.end();
});

try {
    stopRefresh = await startRankingRefresh(pool);
} catch (err) {
    // 정의 없이 돌면 모든 시즌을 건너뛴다. 하트비트를 지우고 끝내야 migrate가 이 인스턴스를 살아 있는 것으로 보지 않는다.
    logger.error('worker startup failed', err);
    await shutdown('startup failed');
    process.exit(1);
}
stopRecovery = startRecovery(pool, redis);
stopScheduler = startScheduler(pool);
stopSettlement = startSettlement(pool, redis);
stopDelivery = startDelivery(pool);
stopLogCleanup = startLogCleanup(pool, logPool);
stopLogCleanupWatch = startLogCleanupWatch(pool);
logger.info('worker started');
// pm2 --wait-ready: 기동 확인을 통과한 뒤에만 준비 완료를 알린다.
process.send?.('ready');
