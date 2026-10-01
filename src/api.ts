import { createServer } from 'node:http';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { ProcessType } from './heartbeat.js';
import { logger } from './logger.js';

const { onShutdown } = await bootstrap('api', ProcessType.API);

// ponytail: node:http 직접 라우팅 — 프레임워크는 2단계에서 정하고 /health도 함께 옮긴다(B-16).
// 서버는 기동 확인을 통과한 뒤에만 만들어지므로 /health 응답 자체가 "확인 통과"를 뜻한다.
const server = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { result: 0 } : { result: 404, message: 'Not Found' }));
});
server.listen(config.apiPort, () => {
    logger.info(`api listening on port ${config.apiPort}`);
    // pm2 --wait-ready: listen까지 성공해야 구버전을 내리게 한다.
    process.send?.('ready');
});

// 새 요청 수신을 멈추고 진행 중 요청이 끝날 때까지 기다린다.
onShutdown(() => new Promise<void>((resolve) => server.close(() => resolve())));
