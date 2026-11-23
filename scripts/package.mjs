/**
 * 배포 패키지 생성 (D-84)
 *
 * dist/를 지우고 다시 빌드한 뒤 podium-de-<version>.tgz를 만든다. 압축 안에 최상위 폴더는 없다.
 * 서버에서는 압축을 풀고 `npm ci --omit=dev --ignore-scripts`만 실행한다(docs/09_OPERATIONS 2절).
 *
 * `--offline`(`npm run package:offline`): 외부 접속이 안 되는 서버용. 임시 폴더에서 운영 의존성만 설치해 node_modules까지 묶은
 * podium-de-<version>-offline.tgz를 만든다. 서버는 풀기만 한다. 저장소의 node_modules는 개발 의존성이
 * 섞여 있어 쓰지 않는다.
 *
 * 앱이 실행 중에 읽는 폴더가 늘면 FILES에도 더한다.
 *
 * 생성: 2026.11.23 trisakion
 * 수정: 2026.11.23 trisakion --offline 추가
 */
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FILES = ['dist', 'database', 'database_log', 'config', 'package.json', 'package-lock.json', '.env.example'];

const offline = process.argv.includes('--offline');
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = resolve(`${name}-${version}${offline ? '-offline' : ''}.tgz`);

rmSync('dist', { recursive: true, force: true });
execSync('npm run build', { stdio: 'inherit' });

// Windows 10 이상과 Linux 모두 tar가 기본 포함되어 있다.
if (!offline) {
    execFileSync('tar', ['-czvf', out, ...FILES], { stdio: 'inherit' });
} else {
    const stage = mkdtempSync(join(tmpdir(), 'podium-package-'));
    try {
        for (const f of FILES)
            cpSync(f, join(stage, f), { recursive: true });
        execSync('npm ci --omit=dev --ignore-scripts', { cwd: stage, stdio: 'inherit' });
        // Windows tar(bsdtar)는 시스템 코드 페이지(CP949 등)로 표현 못 하는 파일 이름에서 충돌한다(0xC0000005).
        // @fastify/send의 테스트 폴더 `snow ☃`가 그렇고, 실행에 쓰지 않으므로 뺀다.
        // ponytail: 경로 하나만 뺀다. 의존성이 늘어 같은 충돌이 나면 그 경로를 여기에 더한다.
        execFileSync('tar', ['-czf', out, '--exclude', 'node_modules/@fastify/send/test', '-C', stage, ...FILES, 'node_modules'], { stdio: 'inherit' });
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
