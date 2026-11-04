import { registerAccountRoutes } from './admin/accounts.js';
import { createAuditWriter, registerAuditRoutes } from './admin/audit.js';
import { registerAuthRoutes } from './admin/auth.js';
import { registerExclusionRoutes } from './admin/exclusions.js';
import { registerRankingRoutes } from './admin/rankings.js';
import { registerReviewRoutes } from './admin/review.js';
import { originGuard, SESSION_COOKIE } from './admin/session.js';
import { bootstrap } from './core/bootstrap.js';
import { ProcessType } from './core/codes.js';
import { config } from './core/config.js';
import { createPool } from './core/db.js';
import { logger } from './core/logger.js';
import { closeRedis, createRedis } from './core/redis.js';
import { buildServer } from './core/server.js';

// 관리 API (01_DESIGN 10.4, D-74). S2S API와 다른 프로세스·포트로 띄워, 관리 트래픽과 장애가 제출 경로에 닿지 않게 한다.
const { pool, onShutdown } = await bootstrap('admin', ProcessType.ADMIN, config.dbQueryTimeoutMs);
// 감사 로그는 로그 DB 전용 풀로 쓴다 — 메인 커넥션을 차지하거나 메인 트랜잭션에 묶이지 않게 한다 (개발 컨벤션 7장).
const logPool = createPool('APP', 'LOG', config.dbQueryTimeoutMs);
const audit = createAuditWriter(logPool);
// 제재 등록·해제가 제외 집합과 순위표를 바로 맞춘다(D-75). 접속을 기다리지 않는다 — 끊겨 있으면 리컨실러가 1분 안에 맞춘다.
const redis = createRedis();

const app = await buildServer({
    title: 'Podium DE Admin API',
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } },
    trustProxy: config.admin.trustProxy,
});
app.decorateRequest('admin', null);
app.addHook('onRequest', originGuard);
registerAuthRoutes(app, { pool, audit });
registerAccountRoutes(app, { pool, audit });
registerAuditRoutes(app, { pool, logPool });
registerRankingRoutes(app, { pool, audit });
registerExclusionRoutes(app, { pool, audit, redis });
registerReviewRoutes(app, { pool, audit });

// 새 요청 수신을 멈추고 진행 중 요청이 끝날 때까지 기다린 뒤, 남은 감사 로그를 적재하고 Redis와 로그 DB 풀을 닫는다.
const shutdown = onShutdown(async () => {
    await app.close();
    await audit.drain();
    await closeRedis(redis);
    await logPool.end();
});

try {
    await app.listen({ port: config.admin.port, host: config.admin.host });
} catch (err) {
    // 포트 충돌 등. 하트비트를 지우고 끝내야 migrate가 이 인스턴스를 살아 있는 것으로 보지 않는다.
    logger.error('admin startup failed', err);
    await shutdown('startup failed');
    process.exit(1);
}
logger.info(`admin listening on ${config.admin.host} port ${config.admin.port}${config.admin.origins.length ? '' : ' (ADMIN_ORIGINS empty: browser writes are rejected)'}`);
process.send?.('ready');
