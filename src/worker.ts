import { bootstrap } from './bootstrap.js';
import { ProcessType } from './codes.js';
import { logger } from './logger.js';

const { onShutdown } = await bootstrap('worker', ProcessType.WORKER);

// ponytail: 등록된 잡 없음 — 스케줄러는 4단계. 하트비트 타이머가 프로세스를 살려 둔다.
logger.info('worker started (no jobs registered)');
// pm2 --wait-ready: 기동 확인을 통과한 뒤에만 준비 완료를 알린다.
process.send?.('ready');

// 잡이 생기면 여기서 스케줄을 먼저 멈춘다(개발 컨벤션 5.2).
onShutdown(async () => {});
