#!/usr/bin/env node
// 이 스크립트는 SKILL.md 15장(커밋 전 크리덴셜 노출 방지)의 구현체다.
// 판정 기준이 바뀌면 SKILL.md 15장과 이 스크립트를 함께 갱신할 것.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

function getRepoRoot() {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
}

function getStagedFiles(repoRoot) {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return out.split('\n').map((f) => f.trim()).filter(Boolean);
}

function isBinary(buf) {
    return buf.slice(0, 8000).includes(0);
}

// 15.1의 플레이스홀더 판별 기준 — 콤마로 나열된 다중값은 호출부에서 분리해 각 값에 적용한다.
const DUMMY_WORDS = new Set([
    'changeme', 'change_me', 'xxx', 'todo', 'test', 'example', 'placeholder',
    'user', 'username', 'pass', 'password', 'secret', 'key', 'none', 'null',
    '생략', '예시', '샘플',
]);

// 코드 파일 확장자 — 이 안에서는 따옴표 없는 값이 문자열 리터럴일 수 없고 항상 식별자/표현식이다.
const CODE_FILE_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|java|kt|kts|cs|php|swift|scala|c|cc|cpp|h|hpp|rs)$/i;

function isCodeSourceFile(filePath) {
    return CODE_FILE_EXT_RE.test(filePath);
}

// i18n 리소스 파일 — 값이 전부 화면에 노출되는 UI 문구라 크리덴셜이 실릴 수 있는 파일 종류가 아니다.
const LOCALE_FILE_RE = /(^|[\\/])locales[\\/].*\.json$/i;

function isLocaleFile(filePath) {
    return LOCALE_FILE_RE.test(filePath);
}

function isSinglePlaceholder(rawValue, isCodeFile) {
    const trimmed = rawValue.trim();
    const value = trimmed.replace(/^['"]|['"]$/g, '');
    if (value === '') return true;
    if (/^your_/i.test(value)) return true;
    if (value.startsWith('<') && value.endsWith('>')) return true;
    if (DUMMY_WORDS.has(value.toLowerCase())) return true;
    if (/^(true|false)$/i.test(value)) return true;
    if (/^\d+(\.\d+)?$/.test(value)) return true; // 순수 숫자
    if (/^\d+(ms|s|m|h|d)$/i.test(value)) return true; // 시간 단위
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(value)) return true; // 로컬 URL
    if (/^(process\.env\.|import\.meta\.env\.|\$\{)/.test(value)) return true; // 코드 참조
    // 코드 파일에서 원본 값이 따옴표(', ", `)로 시작하지 않으면 문법상 문자열 리터럴일 수 없다 —
    // 체이닝 호출/제네릭/함수 인자/유니온 타입 등 어떤 표현식이든 코드 참조이므로 안전하다.
    // 따옴표로 감싸인 실제 문자열 리터럴만 이 분기를 건너뛰어 아래에서 위반으로 남는다.
    if (isCodeFile && !/^['"`]/.test(trimmed)) return true;
    return false;
}

function isPlaceholderValue(rawValue, isCodeFile) {
    return rawValue.split(',').every((part) => isSinglePlaceholder(part, isCodeFile));
}

// 15.1-3의 구조적 크리덴셜 패턴 — 어떤 파일이든 발견되면 무조건 위반.
const STRUCTURAL_PATTERNS = [
    { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub PAT', re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/ },
    { name: 'Private Key 블록', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    {
        name: 'Authorization 헤더 리터럴',
        re: /Authorization['"]?\s*[:=]\s*['"]?(Bearer|Basic)\s+[A-Za-z0-9\-_.=]{8,}/i,
    },
];

// DB/Redis 커넥션 스트링(자격증명 포함) — user/pass가 더미 단어면 문서 예시로 보고 통과시킨다.
const CONNECTION_STRING_RE =
    /\b(mysql|postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/([^:@\/\s]+):([^@\/\s]+)@[^\s'"]+/gi;

// 15.1-3의 KEY=VALUE 형태 시크릿 — 이름에 이 키워드가 들어가면 값을 검사한다.
const SUSPICIOUS_KEY_RE =
    /(secret|password|passwd|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|encryption[_-]?key|auth[_-]?token|jwt[_-]?secret|jwt[_-]?private[_-]?key)/i;

const KV_LINE_RE = /^\s*(?:export\s+)?["']?([A-Za-z0-9_.\-]+)["']?\s*[:=]\s*(.+?)\s*$/;

// 15.1-4의 공인 IP 리터럴 — 예외(사설 대역/루프백)는 통과시킨다.
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function isExemptIp(a, b, c) {
    if (a === 127 || a === 0) return true; // loopback / 0.0.0.0
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 (RFC 5737)
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 (RFC 5737)
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 (RFC 5737)
    return false;
}

function stripComment(line) {
    // `//` 앞이 `:`면 주석이 아니라 URL 스킴(postgres://, https:// 등)이다 — 커넥션 스트링이
    // 통째로 잘려나가 15.1-3 검사를 무력화하지 않도록 이 경우는 주석으로 보지 않는다.
    return line.replace(/\s*(#|(?<!:)\/\/).*$/, '');
}

// 이 스크립트 자신(및 npx skills update/심볼릭 링크 등으로 생긴 사본)을 식별하기 위한 해시 —
// 소비 프로젝트에서 이 파일 경로가 __filename과 다르게 잡히는 경우(심볼릭 링크, 대소문자 차이,
// 스킬 캐시와 로컬 사본 이중 존재 등)에도 스캐너가 자기 셀프테스트 픽스처를 진짜 유출로 오판하지 않도록
// 경로 비교 대신 파일 "전체 내용"의 해시로 판별한다. 코멘트 한 줄 같은 리터럴 문자열을 판별 키로 쓰면
// 그 문자열만 앞에 붙여 실제 크리덴셜을 숨기는 우회가 가능해지므로(공개 저장소라 문자열이 그대로 노출됨)
// 반드시 파일 전체가 실행 중인 스크립트와 (줄바꿈 방식 차이를 제외하고) 바이트 단위로 일치해야만 인정한다.
function normalizeForHash(buf) {
    return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function computeSelfHash() {
    try {
        return crypto.createHash('sha256').update(normalizeForHash(fs.readFileSync(__filename))).digest('hex');
    } catch {
        return null; // __filename을 읽을 수 없으면 자기 자신 판별을 아예 하지 않는다(보수적으로 스캔 대상에 포함)
    }
}

function isSelfScript(buf, selfHash) {
    if (!selfHash) return false;
    return crypto.createHash('sha256').update(normalizeForHash(buf)).digest('hex') === selfHash;
}

function isTemplateFile(filePath) {
    if (/(^|[\\/])\.env\.(example|sample)$/i.test(filePath)) return true;
    if (/(^|[\\/])\.mcp\.json\.sample$/i.test(filePath)) return true;
    return false;
}

/**
 * 한 줄에서 위반을 찾아 violations 배열에 채운다.
 * @param {string} filePath 저장소 루트 기준 상대 경로
 * @param {number} lineNo 1부터 시작하는 줄 번호
 * @param {string} rawLine 원본 줄
 * @param {boolean} isTemplate .env.example/.env.sample/.mcp.json.sample 등 템플릿 파일 여부 — KEY=VALUE 판정 라벨만 달라진다
 * @param {boolean} isCodeFile 소스 코드 파일 여부 — 따옴표 없는 값을 식별자/프로퍼티 접근(코드 참조)으로 인정할지 결정한다
 * @param {boolean} isLocale i18n 리소스 파일 여부 — UI 라벨 키 이름 오탐이 나는 key:value 키 이름 검사만 건너뛴다
 * @param {Array} violations 출력용 위반 목록
 */
function scanLine(filePath, lineNo, rawLine, isTemplate, isCodeFile, isLocale, violations) {
    const line = stripComment(rawLine);
    if (!line.trim()) return;

    for (const { name, re } of STRUCTURAL_PATTERNS) {
        if (re.test(line)) {
            violations.push({ filePath, lineNo, message: `${name} 패턴 발견` });
        }
    }

    // 커넥션 스트링 조각은 문자열 중간에서 잘라낸 값이라 "따옴표로 시작 안 하면 식별자" 전제가 성립하지 않는다 —
    // isCodeFile을 넘기지 않고 항상 리터럴로 취급해 파일 종류 무관하게 검사한다(15.1-3).
    let connMatch;
    CONNECTION_STRING_RE.lastIndex = 0;
    while ((connMatch = CONNECTION_STRING_RE.exec(line)) !== null) {
        const [, scheme, user, pass] = connMatch;
        if (!isSinglePlaceholder(user, false) || !isSinglePlaceholder(pass, false)) {
            violations.push({
                filePath, lineNo,
                message: `${scheme} 커넥션 스트링에 실제 자격증명으로 보이는 값 포함`,
            });
        }
    }

    const kv = line.match(KV_LINE_RE);
    if (kv && !isLocale) {
        const [, key, value] = kv;
        if (SUSPICIOUS_KEY_RE.test(key) && !isPlaceholderValue(value, isCodeFile)) {
            violations.push({
                filePath, lineNo,
                message: isTemplate
                    ? `${key} — 플레이스홀더가 아닌 실제 값으로 보임`
                    : `${key}에 실제 값으로 보이는 크리덴셜 리터럴`,
            });
        }
    }

    let ipMatch;
    IPV4_RE.lastIndex = 0;
    while ((ipMatch = IPV4_RE.exec(line)) !== null) {
        const octets = ipMatch.slice(1, 5).map(Number);
        if (octets.some((n) => n > 255)) continue; // IP 형태가 아닌 숫자 나열
        if (isExemptIp(octets[0], octets[1], octets[2])) continue;
        violations.push({ filePath, lineNo, message: `공인 IP로 보이는 리터럴(${ipMatch[0]})` });
    }
}

// 15.1-1: 로컬 전용 설정/시크릿 파일이 .gitignore로 실제 커버되는지 확인할 때 항상 체크하는 경로.
// 아직 파일이 실존하지 않아도 git check-ignore는 패턴 매칭만으로 판정 가능하다.
const CANONICAL_RISKY_PATHS = ['.env', '.env.local', '.claude/settings.local.json', '.mcp.json'];

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

function isRiskyFilename(name) {
    if (/\.(example|sample)$/i.test(name)) return false; // 템플릿 파일은 커밋 대상이라 제외
    if (name === '.env') return true;
    if (name.startsWith('.env.')) return true;
    if (name === 'settings.local.json') return true;
    if (name === '.mcp.json') return true;
    return false;
}

// 저장소 전체(하위 디렉토리 포함)에서 위험 파일명과 동일한 실제 파일을 재귀 탐색한다 —
// .claude/settings.local.json 같은 파일이 다른 위치(mcp_server_dev/.claude/...)에도 있을 수 있어서다.
function findRiskyFilesInRepo(repoRoot) {
    const found = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (WALK_SKIP_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name));
            } else if (entry.isFile() && isRiskyFilename(entry.name)) {
                const relPath = path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/');
                found.push(relPath);
            }
        }
    }
    walk(repoRoot);
    return found;
}

// git check-ignore가 gitignore 스펙(anchoring 포함)을 직접 해석해 판정한다 —
// .gitignore 텍스트를 파싱해 패턴 존재 여부만 보는 것보다 정확하다.
function isIgnoredByGit(repoRoot, relPath) {
    try {
        execFileSync('git', ['check-ignore', '-v', relPath], { cwd: repoRoot, stdio: 'pipe' });
        return true; // exit 0 = 매칭되는 규칙 있음
    } catch (err) {
        if (err.status === 1) return false; // 매칭되는 규칙 없음
        return false; // 그 외 오류도 보수적으로 미커버 처리(오탐보다 미탐 비용이 크다)
    }
}

function checkGitignoreCoverage(repoRoot, violations) {
    if (!fs.existsSync(path.join(repoRoot, '.gitignore'))) {
        violations.push({ filePath: '.gitignore', lineNo: 0, message: '.gitignore 파일 자체가 없음' });
    }

    const targets = new Set([...CANONICAL_RISKY_PATHS, ...findRiskyFilesInRepo(repoRoot)]);
    for (const relPath of targets) {
        if (isIgnoredByGit(repoRoot, relPath)) continue;
        violations.push({
            filePath: relPath, lineNo: 0,
            message: '.gitignore에 걸리지 않음 — 슬래시 포함 경로형 패턴은 저장소 루트 기준으로만 매칭(anchored)되니, ' +
                '하위 디렉토리까지 덮으려면 `**/` 접두어를 붙일 것 (`git check-ignore -v ' + relPath + '`로 직접 확인 가능)',
        });
    }
}

function main() {
    const repoRoot = getRepoRoot();
    const violations = [];

    checkGitignoreCoverage(repoRoot, violations);

    const staged = getStagedFiles(repoRoot);
    const selfHash = computeSelfHash();

    for (const relPath of staged) {
        const absPath = path.join(repoRoot, relPath);
        if (!fs.existsSync(absPath)) continue; // 삭제된 파일 등
        let buf;
        try {
            buf = fs.readFileSync(absPath);
        } catch {
            continue;
        }
        if (isBinary(buf)) continue;
        if (isSelfScript(buf, selfHash)) continue; // 자기 자신(또는 바이트 단위로 동일한 사본)의 셀프테스트 픽스처 오탐 방지

        const isTemplate = isTemplateFile(relPath);
        const isCodeFile = isCodeSourceFile(relPath);
        const isLocale = isLocaleFile(relPath);
        const text = buf.toString('utf8');
        const lines = text.split(/\r?\n/); // CRLF에서도 stripComment의 `.*$`가 trailing \r에 막히지 않게 함
        lines.forEach((line, idx) => scanLine(relPath, idx + 1, line, isTemplate, isCodeFile, isLocale, violations));
    }

    if (violations.length > 0) {
        console.error('🔴 커밋 전 크리덴셜 스캔 실패 — 아래 항목을 확인하세요:\n');
        for (const v of violations) {
            const loc = v.lineNo > 0 ? `${v.filePath}:${v.lineNo}` : v.filePath;
            console.error(`  ${loc} — ${v.message}`);
        }
        console.error(`\n총 ${violations.length}건. 실제 크리덴셜이면 커밋에서 제외하고 즉시 재발급하세요.`);
        process.exit(1);
    }

    console.log('커밋 전 크리덴셜 스캔 통과.');
    process.exit(0);
}

// `node pre-commit-privacy-scan.js --self-test`로 수동 실행 — 코드 참조(env.db.password류) 오탐 회귀 확인용.
function selfTest() {
    const assert = require('assert');
    assert.strictEqual(isSinglePlaceholder('env.db.password,', true), true, '코드 파일의 프로퍼티 접근은 안전해야 함');
    assert.strictEqual(isSinglePlaceholder('env.logDb.password', true), true, '코드 파일의 프로퍼티 접근은 안전해야 함');
    assert.strictEqual(isSinglePlaceholder('"realSecret123"', true), false, '따옴표로 감싼 리터럴은 여전히 위반이어야 함 — 코드 문법상 문자열 리터럴은 항상 따옴표로 감싸이므로 이걸로 리터럴/식별자를 구분한다');
    assert.strictEqual(isSinglePlaceholder('env.db.password', false), false, '코드 파일이 아니면(.env 등) 이 예외를 적용하면 안 됨 — 이런 파일에서는 따옴표 없는 값도 실제 리터럴이다');
    assert.strictEqual(isSinglePlaceholder("configService.get<string>('DB_PASSWORD'),", true), true, '제네릭+인자 있는 함수 호출도 코드 참조로 인식해야 함');
    assert.strictEqual(isSinglePlaceholder('string | null;', true), true, '유니온 타입도 코드 참조로 인식해야 함');
    assert.strictEqual(isSinglePlaceholder('`sk_live_${x}`', true), false, '백틱 템플릿 리터럴은 여전히 문자열 리터럴로 취급해 위반이어야 함');

    const [crlfLine] = '  api_secret: string; // 암호문\r\nnext'.split(/\r?\n/);
    assert.strictEqual(stripComment(crlfLine), '  api_secret: string;', 'CRLF 파일도 split(/\\r?\\n/)로 줄 끝 \\r를 미리 제거해야 stripComment가 정상 동작함');
    assert.strictEqual(
        stripComment("const uri = 'postgres://admin:pass@host/db'; // 진짜 주석"),
        "const uri = 'postgres://admin:pass@host/db';",
        'URL 스킴의 //는 주석이 아니므로 잘리면 안 되고, 그 뒤 진짜 //주석만 제거해야 함',
    );

    assert.strictEqual(isExemptIp(203, 0, 113), true, 'RFC 5737 TEST-NET-3는 문서 예시용이라 예외여야 함');
    assert.strictEqual(isExemptIp(192, 0, 2), true, 'RFC 5737 TEST-NET-1도 예외여야 함');
    assert.strictEqual(isExemptIp(198, 51, 100), true, 'RFC 5737 TEST-NET-2도 예외여야 함');
    assert.strictEqual(isExemptIp(203, 0, 114), false, 'TEST-NET-3 대역을 벗어나면 여전히 공인 IP로 판정해야 함');

    assert.strictEqual(isSinglePlaceholder('생략', false), true, '한국어 플레이스홀더 관용구도 인식해야 함');
    assert.strictEqual(isLocaleFile('frontend/src/locales/ko/common.json'), true, 'locales/ 하위 json은 i18n 리소스 파일로 인식해야 함');
    assert.strictEqual(isLocaleFile('frontend/src/config/common.json'), false, 'locales/ 밖의 json은 그대로 스캔 대상이어야 함');

    // 코드 파일 안에 하드코딩된 커넥션 스트링은 "따옴표로 시작 안 하면 식별자" 예외를 적용하면 안 됨 —
    // 이 값은 문자열 중간에서 잘라낸 조각이라 코드 참조일 수 없다(control-regression 회귀 방지).
    {
        const v = [];
        scanLine('db.js', 1, "const uri = 'postgres://admin:Sup3r!Secret@10.20.30.40/prod';", false, true, false, v);
        assert.ok(v.some((x) => x.message.includes('커넥션 스트링')), '코드 파일이어도 하드코딩된 커넥션 스트링 자격증명은 잡아야 함');
    }

    // i18n 리소스 파일은 key:value 키 이름 오탐만 면제하고, AWS 키 같은 구조적 패턴은 계속 잡아야 함
    // (allowlist-scope-mismatch 회귀 방지 — 파일 전체를 건너뛰면 안 됨).
    {
        const v = [];
        scanLine('frontend/src/locales/ko/common.json', 1, '  "passwordHint": "비밀번호를 입력하세요",', false, false, true, v);
        assert.strictEqual(v.length, 0, 'locale 파일의 UI 라벨 키 이름 오탐은 계속 면제해야 함');

        const v2 = [];
        scanLine('frontend/src/locales/ko/common.json', 2, '  "leaked": "AKIAABCDEFGHIJKLMNOP",', false, false, true, v2);
        assert.ok(v2.some((x) => x.message.includes('AWS')), 'locale 파일이어도 AWS 키 같은 구조적 패턴은 계속 잡아야 함');
    }

    // 이 스크립트를 커밋할 때 자기 자신의 셀프테스트 픽스처(가짜 커넥션 스트링/AWS 키 예시)를
    // 진짜 유출로 오판하면 안 된다 — 경로가 아니라 파일 전체 내용의 해시로 판별한다(GM Platform 오탐 회귀 방지).
    // 동시에, 리터럴 주석 한 줄만 위조해 실제 크리덴셜을 숨기는 우회가 통하지 않는지도 함께 검증한다.
    {
        const selfHash = computeSelfHash();
        assert.ok(selfHash, '실행 중인 스크립트 자신의 해시는 항상 계산 가능해야 함');
        assert.strictEqual(isSelfScript(fs.readFileSync(__filename), selfHash), true, '자기 자신과 바이트 단위로 동일한 내용은 자기 자신으로 식별해야 함');

        const lfContent = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n');
        const crlfVariant = Buffer.from(lfContent.replace(/\n/g, '\r\n'));
        assert.strictEqual(isSelfScript(crlfVariant, selfHash), true, '줄바꿈 방식만 다른 사본(CRLF 체크아웃 등)도 자기 자신으로 식별해야 함');

        const forged = Buffer.from(
            '#!/usr/bin/env node\n// 이 스크립트는 SKILL.md 15장(커밋 전 크리덴셜 노출 방지)의 구현체다.\n' +
            "const uri = 'postgres://admin:Sup3r!Secret@10.20.30.40/prod';\n",
        );
        assert.strictEqual(isSelfScript(forged, selfHash), false, '서명 주석만 위조하고 내용이 다른 파일은 자기 자신으로 인정하면 안 됨(스캔 우회 방지)');
    }

    console.log('pre-commit-privacy-scan self-test 통과.');
}

if (require.main === module) {
    if (process.argv.includes('--self-test')) {
        selfTest();
    } else {
        main();
    }
}
