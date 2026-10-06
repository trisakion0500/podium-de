import { startCredentialRefresh } from './auth.js';
import { bootstrap } from './bootstrap.js';
import { ProcessType } from './codes.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';

const { pool, onShutdown } = await bootstrap('api', ProcessType.API);

const app = await buildServer();
let stopCredentialRefresh: (() => void) | undefined;
// 새 요청 수신을 멈추고 진행 중 요청이 끝날 때까지 기다린 뒤, DB 풀이 닫히기 전에 키 재조회를 멈춘다.
const shutdown = onShutdown(async () => {
    await app.close();
    stopCredentialRefresh?.();
});

try {
    stopCredentialRefresh = await startCredentialRefresh(pool);
    await app.listen({ port: config.apiPort, host: config.apiHost });
} catch (err) {
    // 키 목록 읽기 실패, 포트 충돌 등. 하트비트를 지우고 끝내야 migrate가 이 인스턴스를 살아 있는 것으로 보지 않는다.
    logger.error('api startup failed', err);
    await shutdown('startup failed');
    process.exit(1);
}
logger.info(`api listening on ${config.apiHost} port ${config.apiPort}`);
// pm2 --wait-ready: listen까지 성공해야 구버전을 내리게 한다.
process.send?.('ready');
