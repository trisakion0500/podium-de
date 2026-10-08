/**
 * k6 제출 부하 스크립트. 트래픽 생성만 한다 — 픽스처 준비·정합 검증·정리는 load.mjs(setup/verify/clean).
 *
 *   k6 run -e KEYS_FILE="$env:TEMP\podium-load.keys" -e RATE=1500 -e DURATION=30s loadtest/k6-submit.js
 *
 * 키 원문은 load.mjs setup이 만든 저장소 밖 파일에서 읽는다(명령줄·저장소에 남기지 않음).
 */
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const keys = JSON.parse(open(__ENV.KEYS_FILE));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    scenarios: {
        submit: {
            // 응답이 느려져도 초당 요청 수를 유지하는 개방형 부하 — load.mjs run과 같은 방식
            executor: 'constant-arrival-rate',
            rate: Number(__ENV.RATE || 1000),
            timeUnit: '1s',
            duration: __ENV.DURATION || '30s',
            preAllocatedVUs: 200,
            maxVUs: 2000,
        },
    },
    // 06_LOAD_TEST 1.1 경보 기준
    thresholds: {
        http_req_duration: ['p(50)<10', 'p(99)<100'],
        http_req_failed: ['rate<0.001'],
    },
    summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

/**
 * 실행 1회에 한 번 호출된다. 실행마다 다른 requestId 접두어를 만든다.
 * @author trisakion
 * @returns {{ run: string }} 이번 실행의 접두어
 */
export function setup() {
    return { run: Date.now().toString(36) };
}

/**
 * VU 반복 1회: 랭킹 931(BEST)에 임의 회원 점수를 제출한다.
 * @author trisakion
 * @modified 2026-10-08 trisakion requestId를 실행 접두어 + 테스트 전체 반복 번호로 변경
 * @param {{ run: string }} data setup()의 반환값
 * @returns {void}
 */
export default function (data) {
    const body = JSON.stringify({
        memberId: Math.floor(Math.random() * 100000),
        value: Math.floor(Math.random() * 8000),
        seasonNo: 1,
        // __VU·__ITER는 실행마다 처음부터 다시 세므로 재실행 시 이전 ID와 겹쳐 멱등 충돌(1104)이 난다
        requestId: `k6-${data.run}-${exec.scenario.iterationInTest}`,
    });
    const res = http.post(`${BASE}/v1/rankings/931/scores`, body, {
        headers: { 'content-type': 'application/json', 'x-api-key': keys.w },
    });
    check(res, { 'status 200': (r) => r.status === 200 });
}
