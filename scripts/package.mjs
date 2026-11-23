/**
 * 배포 패키지 생성 (D-84)
 *
 * dist/를 지우고 다시 빌드한 뒤 podium-de-<version>.tgz를 만든다. 압축 안에 최상위 폴더는 없다.
 * 서버에서는 압축을 풀고 `npm ci --omit=dev --ignore-scripts`만 실행한다(docs/09_OPERATIONS 2절).
 * 앱이 실행 중에 읽는 폴더가 늘면 FILES에도 더한다.
 *
 * 생성: 2026.11.23 trisakion
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const FILES = ['dist', 'database', 'database_log', 'config', 'package.json', 'package-lock.json', '.env.example'];

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = `${name}-${version}.tgz`;

rmSync('dist', { recursive: true, force: true });
execSync('npm run build', { stdio: 'inherit' });
// Windows 10 이상과 Linux 모두 tar가 기본 포함되어 있다.
execFileSync('tar', ['-czvf', out, ...FILES], { stdio: 'inherit' });
