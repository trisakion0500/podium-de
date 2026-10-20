import type { Pool, PoolConnection } from 'mysql2/promise';
import { SpResult } from '../core/codes.js';
import { callSp } from '../core/db.js';
import { logger } from '../core/logger.js';
import { startJob } from './loop.js';

/** 정체 감시 락. 감시 대상 잡과 락을 나눠, 대상 잡이 멈춰도 감시는 돈다 */
const WATCH_LOCK = 'podium:stall-watch';

/** 감시 주기 */
const WATCH_INTERVAL_MS = 600_000;

/** 마지막 성공 후 이만큼 지나면 정체로 본다. 1시간 주기 잡의 3배 — 한두 번의 실패는 다음 주기가 따라잡는다 */
const STALL_SEC = 3 * 3600;

/**
 * 정체 감시 대상 잡 (01_DESIGN 11.4 보관 정리 감시)
 * @author trisakion
 */
export interface StallTarget {
    /** job_state.job_name (랭킹·시즌 무관 행 (0, 0)) */
    job: string;
    /** 로그에 쓰는 잡 이름 */
    name: string;
    /** 정체가 이어지면 생기는 일. 경고 문구 끝에 붙는다 */
    impact: string;
}

/**
 * 잡이 정체됐는지 본다. 마지막 성공(job_state.last_run_at)이 STALL_SEC보다 오래면 정체다.
 * 한 번도 성공하지 않았으면(행 없음) 이 프로세스가 STALL_SEC보다 오래 떠 있을 때만 정체로 본다 — 설치 직후 첫 주기 전에 경고하지 않게 한다.
 * @param conn 메인 DB 커넥션
 * @param job job_state.job_name
 * @param uptimeSec 프로세스 가동 초 (테스트에서 바꾼다)
 * @returns 정체 여부와 마지막 성공 후 지난 초 (null: 성공 기록 없음)
 * @author trisakion
 */
export async function checkJobStall(conn: PoolConnection | Pool, job: string, uptimeSec = process.uptime()): Promise<{ stalled: boolean; ageSec: number | null }> {
    const { result, rows } = await callSp(conn, 'SP_GET_JOB_STATE_AGE', [job, 0, 0]);
    if (result !== SpResult.OK)
        throw new Error(`SP_GET_JOB_STATE_AGE result ${result}`);
    const ageSec: number | null = rows[0].age_sec === null ? null : Number(rows[0].age_sec);
    return { stalled: ageSec === null ? uptimeSec > STALL_SEC : ageSec > STALL_SEC, ageSec };
}

/**
 * 정리 잡 정체 감시를 시작한다. 정리 잡 자신은 멈추면 경고도 못 남기므로 따로 돈다.
 * 잡마다 정체가 시작될 때 한 번 경고하고, 풀리면 한 번 알린다 — 10분마다 같은 경고를 반복하지 않는다.
 * 워커 프로세스 전체가 멈춘 경우는 이 감시도 멈추므로 설치 환경(프로세스 관리자, 인프라 모니터링)의 몫이다.
 * @param pool 메인 DB 풀
 * @param targets 감시할 잡
 * @returns 정지 함수. DB 풀을 닫기 전에 불러야 한다 (개발 컨벤션 5.2)
 * @author trisakion
 */
export function startStallWatch(pool: Pool, targets: StallTarget[]): () => Promise<void> {
    const warned = new Set<string>();
    return startJob(pool, { name: 'stall watch', lock: WATCH_LOCK, intervalMs: WATCH_INTERVAL_MS }, async (ctx) => {
        for (const t of targets) {
            const { stalled, ageSec } = await checkJobStall(ctx.conn, t.job);
            if (stalled && !warned.has(t.job))
                logger.warn(`${t.name} stalled: last success ${ageSec === null ? 'never' : `${Math.floor(ageSec / 60)} min ago`} — ${t.impact}`);
            else if (!stalled && warned.has(t.job))
                logger.info(`${t.name} recovered`);
            if (stalled)
                warned.add(t.job);
            else
                warned.delete(t.job);
        }
    });
}
