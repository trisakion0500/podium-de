/**
 * 회귀 테스트 항목 문서(docs/08_TEST_CASES.md)를 tests/recovery.mjs에서 만든다. 문서를 손으로 고치지 않는다.
 *
 *   node tests/cases-doc.mjs           문서를 다시 쓴다
 *   node tests/cases-doc.mjs --check   문서가 테스트와 같은지만 본다 (다르면 종료 코드 1)
 *
 * recovery.mjs도 끝에 같은 비교를 해서, 테스트를 고치고 문서를 잊으면 FAIL이 난다.
 * @author trisakion
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('recovery.mjs', import.meta.url));
export const DOC = fileURLToPath(new URL('../docs/08_TEST_CASES.md', import.meta.url));

/** 출력 문구에 든 코드 변수를 실제 값으로 바꾼다. 값이 바뀌면 여기도 고친다 */
const VARS = { '${cases.length}': '17', '${qcases.length}': '9', '${burstN}': '260', '시도 ${attempt + 1} 복구 일치': '' };
/** 판정 대상이 아닌 준비 단계 문구. 같은 번호에 다른 문구가 있으면 뺀다 */
const PREP = new Set(['준비', '픽스처 시즌 준비']);

/**
 * 최상위 함수마다 본문을 나눈다.
 * @param lines 소스 줄
 * @returns 함수 이름 → 본문
 */
function topFunctions(lines) {
    const fns = new Map();
    let name = null;
    for (const line of lines) {
        const m = /^(?:async )?function (\w+)/.exec(line);
        if (m)
            name = m[1];
        else if (/^\S/.test(line) && !line.startsWith('}'))
            name = null;
        if (name)
            fns.set(name, (fns.get(name) ?? '') + line + '\n');
    }
    return fns;
}

/**
 * 테스트 소스에서 문서 본문을 만든다. 구간은 실행 목록의 순서, 보조 함수는 그것을 부르는 구간에 넣는다.
 * @param src recovery.mjs 내용
 * @returns 문서 전체 (LF)
 * @author trisakion
 */
export function renderCasesDoc(src = readFileSync(SRC, 'utf8')) {
    const lines = src.replace(/\r/g, '').split('\n');
    const fns = topFunctions(lines);
    // 실행 목록(for (const [name, fn] of [...]))에서만 구간을 읽는다. 다른 배열의 ['문자열', 이름] 쌍은 구간이 아니다.
    const runList = src.slice(src.indexOf('for (const [name, fn] of ['), src.indexOf('.filter(([name])'));
    const sections = [...runList.matchAll(/\['([^']+)', (\w+)\]/g)].map((m) => ({ name: m[1], fn: m[2] }));
    const owner = new Map(sections.map((s) => [s.fn, s.name]));
    // 보조 함수가 다른 보조 함수를 부를 수 있어 더 늘지 않을 때까지 넓힌다.
    for (let grew = true; grew;) {
        grew = false;
        for (const [fn, body] of fns) {
            if (!owner.has(fn))
                continue;
            for (const other of fns.keys())
                if (!owner.has(other) && new RegExp(`\\b${other}\\(`).test(body)) {
                    owner.set(other, owner.get(fn));
                    grew = true;
                }
        }
    }
    const cases = new Map(sections.map((s) => [s.name, new Map()]));
    for (const [fn, body] of fns) {
        for (const m of body.matchAll(/[(`']([A-Z]\d+[a-z]?) ([^'`]*)/g)) {
            if (!owner.has(fn))
                throw new Error(`${m[1]}이(가) 구간에 속하지 않는 함수 ${fn}에 있습니다`);
            let text = m[2].trim();
            for (const [k, v] of Object.entries(VARS))
                text = text.replace(k, v).trim();
            const byId = cases.get(owner.get(fn));
            const texts = byId.get(m[1]) ?? [];
            if (text && !texts.includes(text))
                texts.push(text);
            byId.set(m[1], texts);
        }
    }
    const order = (id) => /([A-Z])(\d+)(.*)/.exec(id);
    const cmp = (a, b) => {
        const [, la, na, sa] = order(a);
        const [, lb, nb, sb] = order(b);
        return la.localeCompare(lb) || Number(na) - Number(nb) || sa.localeCompare(sb);
    };
    const out = [
        '# 회귀 테스트 항목',
        '',
        '`tests/recovery.mjs`의 항목 번호가 무엇을 확인하는지 구간별로 적는다. 실행 방법과 결과 읽기는 [03_DEV_SETUP 4.4](03_DEV_SETUP.md#44-회귀-테스트)를 본다.',
        '',
        '> 이 문서는 `node tests/cases-doc.mjs`가 만든다. 손으로 고치지 않는다. 테스트를 고친 뒤 다시 만들지 않으면 회귀 테스트 마지막의 문서 일치 항목이 FAIL이 된다.',
        '',
        '- 설명은 테스트가 출력하는 문구 그대로다. 한 번호에 판정이 여러 개면 ` / `로 잇는다.',
        '- 글자는 구간 표시일 뿐 뜻은 없다. L(락 대기 제한·로그 정리)과 G(시즌 스케줄러·관리 API)는 두 구간에 있으므로 구간과 함께 읽는다.',
        '- 번호는 추가된 순서라 실행 순서와 다를 수 있다.',
    ];
    for (const { name } of sections) {
        out.push('', `## ${name}`, '', '| 번호 | 확인하는 것 |', '| --- | --- |');
        const byId = cases.get(name);
        for (const id of [...byId.keys()].sort(cmp)) {
            const texts = byId.get(id).filter((t) => !PREP.has(t));
            const text = (texts.length ? texts : byId.get(id)).join(' / ').replace(/\|/g, '\\|').replace(/~/g, '\\~');
            out.push(`| ${id} | ${text} |`);
        }
    }
    return out.join('\n') + '\n';
}

/**
 * 문서가 지금 테스트와 같은지 본다.
 * @returns 같으면 true
 * @author trisakion
 */
export function casesDocUpToDate() {
    try {
        return readFileSync(DOC, 'utf8').replace(/\r/g, '') === renderCasesDoc();
    } catch {
        return false;
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.includes('--check')) {
        const ok = casesDocUpToDate();
        console.log(ok ? 'docs/08_TEST_CASES.md 최신' : 'docs/08_TEST_CASES.md 갱신 필요: node tests/cases-doc.mjs');
        process.exitCode = ok ? 0 : 1;
    } else {
        writeFileSync(DOC, renderCasesDoc());
        console.log('docs/08_TEST_CASES.md 작성');
    }
}
