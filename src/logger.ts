import fs from 'node:fs';
import path from 'node:path';
import log4js from 'log4js';
import type { Configuration } from 'log4js';

/**
 * `config/log4js.json`은 프로젝트 루트(`process.cwd()`) 기준으로 찾는다 — dist에서 실행해도 같은 파일을 가리키게 하기 위함이다.
 */
const configPath = path.resolve(process.cwd(), 'config/log4js.json');

/**
 * 프로세스 역할(api/worker/migrate). API와 워커는 같은 호스트에서 별도 프로세스로 뜨므로
 * 같은 로그 파일을 공유하지 않도록 엔트리 파일명으로 구분한다(개발 컨벤션 7.4).
 */
const role = path.basename(process.argv[1] ?? 'app', '.js');

/**
 * 인스턴스 식별자(개발 컨벤션 7.4). 로깅은 설정 모듈보다 먼저 로드되므로 `process.env`를 직접 읽는다.
 * PM2 클러스터 모드는 `NODE_APP_INSTANCE`를, Docker/k8s는 `INSTANCE_ID`를 주입한다고 가정한다.
 * 둘 다 없으면(로컬 단일 인스턴스) suffix를 붙이지 않는다.
 */
const instanceId = process.env.NODE_APP_INSTANCE || process.env.INSTANCE_ID;

/**
 * 파일 계열 appender(`file`/`dateFile`)의 `filename`에 역할·인스턴스 suffix를 붙인다.
 * `dateFile`의 날짜 회전 suffix는 이 filename 뒤에 붙으므로 순서가 바뀌지 않는다.
 * @param rawConfig 파일에서 읽은 원본 log4js 설정
 * @returns 파일 계열 appender의 filename만 바꾼 설정
 */
function withFileSuffix(rawConfig: Configuration): Configuration {
    const suffix = instanceId ? `.${role}.${instanceId}` : `.${role}`;
    const appenders = Object.fromEntries(
        Object.entries(rawConfig.appenders).map(([name, appender]) => {
            if (appender.type !== 'file' && appender.type !== 'dateFile')
                return [name, appender];
            const withFilename = appender as { filename: string };
            return [name, { ...withFilename, filename: `${withFilename.filename}${suffix}` }];
        }),
    );
    return { ...rawConfig, appenders };
}

/**
 * log4js 설정 파일을 읽어 적용한다. 기동 시 한 번, 이후 SIGHUP을 받을 때마다 재호출된다.
 * 파일이 없거나 파싱에 실패해도 로거가 죽지 않도록 콘솔 전용 설정으로 폴백한다.
 */
function loadConfig(): void {
    try {
        const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Configuration;
        log4js.configure(withFileSuffix(rawConfig));
    } catch (err) {
        log4js.configure({
            appenders: { out: { type: 'stdout' } },
            categories: { default: { appenders: ['out'], level: 'info' } },
        });
        log4js.getLogger().error(`failed to load log4js config from ${configPath}, falling back to console`, err);
    }
}

loadConfig();

// 파일 watcher는 두지 않음 — 설정 변경은 재시작이 기본, 무중단 반영이 필요하면 SIGHUP으로 명시적 트리거
process.on('SIGHUP', loadConfig);

/**
 * 프로젝트 전역에서 쓰는 log4js 기본 카테고리 로거.
 * @author trisakion
 */
export const logger = log4js.getLogger();

/**
 * 버퍼에 남은 로그를 파일에 내보내고 appender를 닫는다. 프로세스 종료 직전에 호출한다.
 * @returns 종료 완료 Promise
 * @author trisakion
 */
export function shutdownLogger(): Promise<void> {
    return new Promise((resolve) => log4js.shutdown(() => resolve()));
}
