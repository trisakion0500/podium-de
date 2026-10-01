#!/usr/bin/env node
/**
 * 전체 아키텍처 IR 하나(55노드 88엣지처럼 밀집된 것)를
 * "개요(컨텍스트=박스 하나) + 컨텍스트별 상세" 여러 IR로 쪼갠다.
 * render.mjs가 만드는 IR 스키마/렌더러는 그대로 재사용 — 이 스크립트는 IR을
 * 분할하는 전처리만 담당한다.
 *
 * 사용법: node .claude/scripts/arch/split-by-context.mjs <full-ir.json> <outDir> <baseName>
 *
 * 분할 규칙(ponytail: 계층/그래프 라이브러리 없이 boundary 필드 하나로 판단):
 * - 개요: 원본 boundaries를 "기능 컨텍스트"/"공용·부트스트랩" 두 스윔레인으로 모으고,
 *   각 boundary를 노드 하나로 접는다(kind: context). 서로 다른 boundary를 잇는
 *   엣지만 (from-boundary, to-boundary) 쌍으로 집계해 건수를 라벨로 남긴다.
 * - 컨텍스트별 상세(boundary B): B 소속 노드 전부 + B와 "공용/부트스트랩"
 *   boundary(infra/bootstrap) 사이를 잇는 엣지의 상대편 노드만 끌어온다.
 *   B가 다른 기능(feature) boundary와 맺는 엣지는 여기서 뺀다 — 그건 개요에서만
 *   보이면 된다. 단 B 자신이 infra/bootstrap(공용 계층)이면 원래도 여러 기능을
 *   가로지르는 게 그 계층의 본래 역할이라 예외 없이 다 끌어온다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SUPPORT_BOUNDARIES = new Set(["infra", "bootstrap"]);

const [, , irPath, outDir, baseName] = process.argv;
if (!irPath || !outDir || !baseName) {
    console.error("사용법: node split-by-context.mjs <full-ir.json> <outDir> <baseName>");
    process.exit(1);
}

const ir = JSON.parse(readFileSync(irPath, "utf-8"));
const boundaryById = new Map(ir.boundaries.map((b) => [b.id, b]));
const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));

mkdirSync(outDir, { recursive: true });

// ---- 개요 ----
function buildOverview() {
    const boundaries = [
        { id: "features", label: "기능 컨텍스트" },
        { id: "support", label: "공용/부트스트랩" },
    ];

    const nodes = ir.boundaries.map((b) => ({
        id: `ctx_${b.id}`,
        label: b.label,
        kind: "context",
        boundary: SUPPORT_BOUNDARIES.has(b.id) ? "support" : "features",
        evidence: { file: irPath },
    }));

    const edgeCount = new Map();
    for (const e of ir.edges) {
        const fromB = nodeById.get(e.from)?.boundary;
        const toB = nodeById.get(e.to)?.boundary;
        if (!fromB || !toB || fromB === toB)
            continue;
        const key = `${fromB}->${toB}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }

    const edges = [...edgeCount.entries()].map(([key, count]) => {
        const [from, to] = key.split("->");
        return { from: `ctx_${from}`, to: `ctx_${to}`, label: `${count}개 연결` };
    });

    return {
        name: `${baseName}-overview`,
        commit: ir.commit,
        generatedAt: ir.generatedAt,
        boundaries,
        nodes,
        edges,
    };
}

// ---- 컨텍스트별 상세 ----
function buildContext(boundaryId) {
    const isSupport = SUPPORT_BOUNDARIES.has(boundaryId);
    const nodeIds = new Set(ir.nodes.filter((n) => n.boundary === boundaryId).map((n) => n.id));
    const pulledBoundaries = new Set();
    const edges = [];

    for (const e of ir.edges) {
        const a = nodeById.get(e.from);
        const b = nodeById.get(e.to);
        if (!a || !b)
            continue;
        const aIn = a.boundary === boundaryId;
        const bIn = b.boundary === boundaryId;

        if (aIn && bIn) {
            edges.push(e);
        } else if (aIn && SUPPORT_BOUNDARIES.has(b.boundary)) {
            nodeIds.add(b.id);
            pulledBoundaries.add(b.boundary);
            edges.push(e);
        } else if (bIn && SUPPORT_BOUNDARIES.has(a.boundary)) {
            nodeIds.add(a.id);
            pulledBoundaries.add(a.boundary);
            edges.push(e);
        } else if (isSupport && aIn) {
            // 공용 계층(B) 자신이 호출하는 방향만 끌어온다 — 반대 방향(다른 모든
            // 기능이 이 공용 계층으로 걸어오는 호출)까지 끌어오면 infra류 파일이
            // 사실상 전체 그래프와 다시 같아진다(모든 기능이 masterDataCache/
            // writeAuditLog 등을 부르므로). 그 "누가 호출하는가"는 각 기능
            // 컨텍스트 파일에 이미 표시되고, 개요에도 집계되어 있다.
            nodeIds.add(b.id);
            pulledBoundaries.add(b.boundary);
            edges.push(e);
        }
    }

    const boundaries = [boundaryById.get(boundaryId), ...[...pulledBoundaries].map((id) => boundaryById.get(id))];
    const nodes = ir.nodes.filter((n) => nodeIds.has(n.id));

    return {
        name: `${baseName}-${boundaryId}`,
        commit: ir.commit,
        generatedAt: ir.generatedAt,
        boundaries,
        nodes,
        edges,
    };
}

// ---- 인덱스 문서 ----
function buildIndexMarkdown(contextNames) {
    const lines = [];
    lines.push(`# 아키텍처 문서 — ${baseName}`);
    lines.push("");
    lines.push(
        `기준 커밋 \`${ir.commit}\` 시점의 서버 구조 스냅샷. 하나의 큰 다이어그램 대신 개요 1개 +`,
    );
    lines.push(
        "컨텍스트별 상세 " + ir.boundaries.length + "개로 나눠져 있다(분할 기준은 " +
        "`.claude/scripts/arch/split-by-context.mjs` 참고). 각 문서는 같은 이름의 `.svg`를 함께 갖는다.",
    );
    lines.push("");
    lines.push("## 개요");
    lines.push("");
    lines.push(
        `- [${baseName}-overview.md](${baseName}-overview.md) — ${ir.boundaries.length}개 ` +
        "컨텍스트를 박스 하나로 접고, 컨텍스트 간 연결만 집계해서 보여준다. 전체 그림이 " +
        "필요할 때 여기부터 본다.",
    );
    lines.push("");
    lines.push("## 컨텍스트별 상세");
    lines.push("");
    lines.push("| 컨텍스트 | 문서 |");
    lines.push("|---|---|");
    for (const { label, name } of contextNames)
        lines.push(`| ${label} | [${name}.md](${name}.md) |`);
    lines.push("");
    lines.push(
        "각 상세 문서는 그 컨텍스트 자신의 노드 + 공용 인프라로 나가는 호출만 담는다 — " +
        "다른 기능 컨텍스트로 넘어가는 호출은 개요 쪽에만 집계되어 있다.",
    );
    lines.push("");
    return lines.join("\n");
}

const overview = buildOverview();
writeFileSync(join(outDir, `${overview.name}.json`), JSON.stringify(overview, null, 2));
console.log(`작성됨: ${overview.name}.json (노드 ${overview.nodes.length}개, 엣지 ${overview.edges.length}개)`);

const contextNames = [];
for (const b of ir.boundaries) {
    const ctx = buildContext(b.id);
    writeFileSync(join(outDir, `${ctx.name}.json`), JSON.stringify(ctx, null, 2));
    console.log(`작성됨: ${ctx.name}.json (노드 ${ctx.nodes.length}개, 엣지 ${ctx.edges.length}개)`);
    contextNames.push({ label: b.label, name: ctx.name });
}

writeFileSync(join(outDir, `${baseName}.md`), buildIndexMarkdown(contextNames));
console.log(`작성됨: ${baseName}.md (인덱스)`);
