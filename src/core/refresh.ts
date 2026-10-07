import { logger } from './logger.js';

/** 재조회가 이 횟수만큼 연속 실패하면 error로 알린다 */
const REFRESH_ALERT_AFTER = 3;

/**
 * DB 목록을 메모리에 올리고 주기적으로 다시 읽는다. API 키 목록과 랭킹 정의 캐시가 같이 쓴다.
 * 기동 시 읽기 실패는 예외로 던진다 — 목록 없이 뜨면 모든 요청이 거부되므로 뜨지 않는 편이 낫다.
 * 재조회 실패는 기존 목록을 유지하고 경고하며, 연속 실패는 변경이 반영되지 않는 상태라 error로 올린다.
 * @param label 로그에 쓸 대상 이름
 * @param load 목록을 읽어 메모리 목록을 바꾸고 건수를 돌려주는 함수
 * @param intervalMs 재조회 주기
 * @param staleImpact 연속 실패 시 error 로그에 덧붙일 영향 설명
 * @returns 기동 시 읽은 건수와 재조회 정지 함수. 정지 함수는 정상 종료 때 DB 풀보다 먼저 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export async function startPeriodicLoad(label: string, load: () => Promise<number>, intervalMs: number, staleImpact: string): Promise<{ count: number; stop: () => void }> {
    const count = await load();
    logger.info(`${label} loaded: ${count}`);

    let failures = 0;
    let kept = count;
    let running = false;
    const timer = setInterval(async () => {
        // 쿼리 타임아웃이 없어 DB가 멈추면 이전 재조회가 끝나지 않는다. 겹쳐 쌓이며 풀 커넥션을 잡지 않게 이번 차례는 건너뛴다.
        if (running)
            return;
        running = true;
        try {
            kept = await load();
            if (failures >= REFRESH_ALERT_AFTER)
                logger.info(`${label} refresh recovered after ${failures} failures`);
            failures = 0;
        } catch (err) {
            failures++;
            if (failures >= REFRESH_ALERT_AFTER)
                logger.error(`${label} refresh failed ${failures} times in a row — ${staleImpact}, keeping ${kept}`, err);
            else
                logger.warn(`${label} refresh failed, keeping ${kept}`, err);
        } finally {
            running = false;
        }
    }, intervalMs);
    return { count, stop: () => clearInterval(timer) };
}
