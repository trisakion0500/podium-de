import { bootstrap } from './core/bootstrap.js';
import { ProcessType } from './core/codes.js';
import { logger } from './core/logger.js';
import { startRankingRefresh } from './core/rankings.js';
import { closeRedis, createRedis } from './core/redis.js';
import { startRecovery } from './worker/recovery.js';

const { pool, onShutdown } = await bootstrap('worker', ProcessType.WORKER);
const redis = createRedis();

let stopRecovery: (() => Promise<void>) | undefined;
let stopRefresh: (() => void) | undefined;
// 잡을 먼저 멈춘 뒤 정의 재조회, Redis 순으로 닫는다. DB 풀은 bootstrap이 마지막에 닫는다 (개발 컨벤션 5.2).
const shutdown = onShutdown(async () => {
    await stopRecovery?.();
    stopRefresh?.();
    await closeRedis(redis);
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
// ponytail: 시즌 스케줄러(생성, 상태 전이, 정산, 전달)는 4단계 구현 예정.
logger.info('worker started');
// pm2 --wait-ready: 기동 확인을 통과한 뒤에만 준비 완료를 알린다.
process.send?.('ready');
