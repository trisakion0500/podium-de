#!/usr/bin/env node
/**
 * trisakion-architecture-snapshot-generator 전용 PreToolUse 훅.
 * 이 에이전트는 md/SVG/인덱스 문서를 직접 쓰지 않고 .claude/scripts/arch/render.mjs와
 * .claude/scripts/arch/split-by-context.mjs로만 만들어야 하며, Bash는 기준 커밋 확인(git)과
 * 이 두 스크립트 실행 외의 임의 명령을 실행하면 안 된다. 그 제약을 여기서 구조적으로
 * 강제한다(에이전트 지시문 위반을 사후 리뷰가 아니라 시도 시점에 막는다).
 */
function deny(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

function allow() {
    process.exit(0);
}

const GENERATED_FILE = /docs[\\/]architecture[\\/].*\.(md|svg)$/i;

// 접두사 정규식(^...)은 "git status; rm -rf ~"처럼 뒤에 임의 명령을 붙여도
// 매치되므로 셸 체이닝을 막지 못한다. 메타문자를 먼저 거르고, argv를 토큰
// 단위로 쪼개 정확히 일치하는지 확인한다.
const SHELL_METACHARS = /[;&|`$<>\n]/;
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);
// 에이전트 지시문(1단계 "git rev-parse --short HEAD")이 실제로 쓰는 플래그만 예외로 둔다.
const SAFE_GIT_FLAGS = new Set(["--short"]);
const RENDER_SCRIPTS = new Set([
    ".claude/scripts/arch/render.mjs",
    "./.claude/scripts/arch/render.mjs",
    ".claude/scripts/arch/split-by-context.mjs",
    "./.claude/scripts/arch/split-by-context.mjs",
]);

function isAllowedBashCommand(command) {
    if (!command || SHELL_METACHARS.test(command)) return false;
    const argv = command.trim().split(/\s+/);
    if (argv[0] === "git") {
        // -c/-o/--upload-pack 등 git 동작을 바꾸는 옵션은 SAFE_GIT_FLAGS에 없으면 통째로 거부한다.
        return (
            GIT_READONLY_SUBCOMMANDS.has(argv[1]) &&
            argv.slice(2).every((a) => !a.startsWith("-") || SAFE_GIT_FLAGS.has(a))
        );
    }
    if (argv[0] === "node") {
        return argv.length >= 2 && RENDER_SCRIPTS.has(argv[1].replace(/\\/g, "/"));
    }
    return false;
}

async function main() {
    const raw = await new Promise((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
    });

    let input;
    try {
        input = JSON.parse(raw);
    } catch {
        return allow();
    }

    const { tool_name, tool_input } = input;

    if (tool_name === "Bash") {
        const command = (tool_input?.command ?? "").trim();
        if (isAllowedBashCommand(command))
            return allow();
        return deny(
            `이 에이전트의 Bash는 git 조회 명령과 render.mjs 실행만 허용됩니다. 차단된 명령: ${command}`
        );
    }

    if (tool_name === "Write" || tool_name === "Edit") {
        const filePath = tool_input?.file_path ?? "";
        if (GENERATED_FILE.test(filePath))
            return deny(
                `docs/architecture/ 아래 .md/.svg는 render.mjs만 생성해야 합니다. IR(JSON)을 고친 뒤 render.mjs를 다시 실행하세요. 차단된 경로: ${filePath}`
            );
        return allow();
    }

    return allow();
}

main();
