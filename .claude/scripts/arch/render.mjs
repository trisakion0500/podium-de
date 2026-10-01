#!/usr/bin/env node
/**
 * 아키텍처 IR(JSON) -> validate / render(md + svg).
 * 사용법:
 *   node .claude/scripts/arch/render.mjs validate <ir.json> [--json]
 *   node .claude/scripts/arch/render.mjs render <ir.json>
 *
 * ponytail: 스키마 검증은 ajv 없이 손으로 짠다 — 이 IR 하나의 좁은 스키마엔 충분하고
 * 새 의존성을 들일 이유가 없다. 레이아웃도 force-directed 라이브러리 없이
 * boundary(스윔레인) x kind(고정 순서) 그리드로 충분하다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename, extname } from "node:path";

const KIND_ORDER = [
    "context",
    "entrypoint",
    "route",
    "service",
    "repository",
    "infra",
    "external",
    "env",
    "other",
];

/** @returns {{valid: boolean, diagnostics: {path: string, message: string}[]}} */
function validateIr(ir) {
    const diagnostics = [];
    const push = (path, message) => diagnostics.push({ path, message });

    for (const field of ["commit", "generatedAt", "boundaries", "nodes", "edges"])
        if (!(field in ir))
            push(`$.${field}`, "필수 필드가 없습니다");

    const boundaries = Array.isArray(ir.boundaries) ? ir.boundaries : [];
    const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
    const edges = Array.isArray(ir.edges) ? ir.edges : [];

    const boundaryIds = new Set();
    boundaries.forEach((b, i) => {
        if (!b || typeof b.id !== "string" || !b.id)
            push(`$.boundaries[${i}].id`, "id가 비어있습니다");
        else if (boundaryIds.has(b.id))
            push(`$.boundaries[${i}].id`, `중복된 boundary id: ${b.id}`);
        else
            boundaryIds.add(b.id);
        if (!b || typeof b.label !== "string" || !b.label)
            push(`$.boundaries[${i}].label`, "label이 비어있습니다");
    });

    const nodeIds = new Set();
    nodes.forEach((n, i) => {
        const p = `$.nodes[${i}]`;
        if (!n || typeof n.id !== "string" || !n.id)
            push(`${p}.id`, "id가 비어있습니다");
        else if (nodeIds.has(n.id))
            push(`${p}.id`, `중복된 node id: ${n.id}`);
        else
            nodeIds.add(n.id);
        if (!n || typeof n.label !== "string" || !n.label)
            push(`${p}.label`, "label이 비어있습니다");
        if (!n || !KIND_ORDER.includes(n.kind))
            push(`${p}.kind`, `kind는 ${KIND_ORDER.join("/")} 중 하나여야 합니다`);
        if (!n || typeof n.boundary !== "string" || !boundaryIds.has(n.boundary))
            push(`${p}.boundary`, `존재하지 않는 boundary 참조: ${n?.boundary}`);
        if (!n || !n.evidence || typeof n.evidence.file !== "string" || !n.evidence.file)
            push(`${p}.evidence.file`, "evidence.file이 비어있습니다 — 확인하지 못한 노드는 만들지 않는다");
        if (n?.confidence && !["confirmed", "weak"].includes(n.confidence))
            push(`${p}.confidence`, "confidence는 confirmed/weak만 허용됩니다");
    });

    edges.forEach((e, i) => {
        const p = `$.edges[${i}]`;
        if (!e || !nodeIds.has(e.from))
            push(`${p}.from`, `존재하지 않는 node 참조: ${e?.from}`);
        if (!e || !nodeIds.has(e.to))
            push(`${p}.to`, `존재하지 않는 node 참조: ${e?.to}`);
    });

    return { valid: diagnostics.length === 0, diagnostics };
}

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

/** boundary(행) x kind(고정 열 순서) 그리드로 좌표를 계산한다 */
function layout(ir) {
    const NODE_W = 200, NODE_H = 48, H_GAP = 32, V_GAP = 24;
    const HEADER_H = 34, PAD = 20, BOUNDARY_GAP = 36;
    const MAX_COLS = 4;

    const byBoundary = new Map(ir.boundaries.map((b) => [b.id, []]));
    for (const n of ir.nodes) {
        const list = byBoundary.get(n.boundary);
        if (list)
            list.push(n);
    }

    const positions = new Map();
    let y = PAD;
    let maxWidth = 0;
    const boundaryBoxes = [];

    for (const b of ir.boundaries) {
        const list = (byBoundary.get(b.id) ?? []).slice().sort(
            (a, c) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(c.kind)
        );
        const cols = Math.min(MAX_COLS, Math.max(1, list.length));
        const rows = Math.ceil(list.length / cols) || 1;
        const bodyTop = y + HEADER_H;

        list.forEach((n, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            positions.set(n.id, {
                x: PAD + col * (NODE_W + H_GAP),
                y: bodyTop + row * (NODE_H + V_GAP),
                w: NODE_W,
                h: NODE_H,
            });
        });

        const boxHeight = HEADER_H + rows * NODE_H + (rows - 1) * V_GAP + PAD;
        const boxWidth = cols * NODE_W + (cols - 1) * H_GAP + PAD * 2;
        boundaryBoxes.push({ id: b.id, label: b.label, x: PAD / 2, y, w: boxWidth, h: boxHeight });
        maxWidth = Math.max(maxWidth, boxWidth + PAD);
        y += boxHeight + BOUNDARY_GAP;
    }

    return { positions, boundaryBoxes, width: maxWidth + PAD, height: y };
}

function buildSvg(ir) {
    const colors = { bg: "#ffffff", boundary: "#f4f4f8", boundaryStroke: "#c8c8dc", text: "#1a1a2e",
        node: "#eef0ff", nodeStroke: "#6c6ca0", edge: "#6a6a8a", weak: "#b8860b" };

    const { positions, boundaryBoxes, width, height } = layout(ir);
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, sans-serif">`);
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${colors.bg}"/>`);
    parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colors.edge}"/></marker></defs>`);

    for (const b of boundaryBoxes) {
        parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${colors.boundary}" stroke="${colors.boundaryStroke}"/>`);
        parts.push(`<text x="${b.x + 10}" y="${b.y + 22}" fill="${colors.text}" font-size="15" font-weight="600">${esc(b.label)}</text>`);
    }

    for (const e of ir.edges) {
        const from = positions.get(e.from), to = positions.get(e.to);
        if (!from || !to)
            continue;
        const x1 = from.x + from.w / 2, y1 = from.y + from.h / 2;
        const x2 = to.x + to.w / 2, y2 = to.y + to.h / 2;
        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors.edge}" stroke-width="1.5" marker-end="url(#arrow)"/>`);
        if (e.label) {
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            parts.push(`<text x="${mx}" y="${my - 4}" fill="${colors.edge}" font-size="11" text-anchor="middle">${esc(e.label)}</text>`);
        }
    }

    for (const n of ir.nodes) {
        const p = positions.get(n.id);
        if (!p)
            continue;
        const stroke = n.confidence === "weak" ? colors.weak : colors.nodeStroke;
        parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" fill="${colors.node}" stroke="${stroke}" stroke-width="${n.confidence === "weak" ? 2 : 1}"/>`);
        parts.push(`<text x="${p.x + p.w / 2}" y="${p.y + 18}" fill="${colors.text}" font-size="12" font-weight="600" text-anchor="middle">${esc(n.label)}</text>`);
        parts.push(`<text x="${p.x + p.w / 2}" y="${p.y + 34}" fill="${colors.edge}" font-size="10" text-anchor="middle">${esc(n.kind)}</text>`);
    }

    parts.push("</svg>");
    return parts.join("\n");
}

function buildMarkdown(ir, name) {
    const lines = [];
    lines.push(`# 아키텍처 스냅샷 — ${name}`);
    lines.push("");
    lines.push(`- 기준 커밋: \`${ir.commit}\``);
    lines.push(`- 생성 시각: ${ir.generatedAt}`);
    lines.push(`- 경계: ${ir.boundaries.map((b) => b.label).join(", ")}`);
    lines.push(`- 노드 ${ir.nodes.length}개, 엣지 ${ir.edges.length}개`);
    lines.push("");
    lines.push(`![architecture](${name}.svg)`);
    lines.push("");
    lines.push("## 노드");
    lines.push("");
    lines.push("| boundary | kind | label | evidence | 신뢰도 |");
    lines.push("|---|---|---|---|---|");
    const boundaryLabel = new Map(ir.boundaries.map((b) => [b.id, b.label]));
    for (const n of ir.nodes) {
        const ev = n.evidence.lineStart
            ? `${n.evidence.file}:${n.evidence.lineStart}${n.evidence.lineEnd && n.evidence.lineEnd !== n.evidence.lineStart ? `-${n.evidence.lineEnd}` : ""}`
            : n.evidence.file;
        const conf = n.confidence === "weak" ? "🟡 추정" : "";
        lines.push(`| ${boundaryLabel.get(n.boundary) ?? n.boundary} | ${n.kind} | ${n.label} | \`${ev}\` | ${conf} |`);
    }
    lines.push("");
    lines.push("## 엣지");
    lines.push("");
    lines.push("| from | to | label |");
    lines.push("|---|---|---|");
    const nodeLabel = new Map(ir.nodes.map((n) => [n.id, n.label]));
    for (const e of ir.edges)
        lines.push(`| ${nodeLabel.get(e.from) ?? e.from} | ${nodeLabel.get(e.to) ?? e.to} | ${e.label ?? ""} |`);
    if (ir.excluded?.length) {
        lines.push("");
        lines.push("## 범위 제외");
        lines.push("");
        for (const x of ir.excluded)
            lines.push(`- **${x.what}** — ${x.why}`);
    }
    lines.push("");
    return lines.join("\n");
}

function main() {
    const [cmd, irPath, ...rest] = process.argv.slice(2);
    if (!cmd || !irPath) {
        console.error("사용법: node render.mjs <validate|render> <ir.json> [--json]");
        process.exit(1);
    }

    const ir = JSON.parse(readFileSync(irPath, "utf-8"));
    const dir = dirname(irPath);
    const name = ir.name || basename(irPath, extname(irPath));

    if (cmd === "validate") {
        const result = validateIr(ir);
        if (rest.includes("--json"))
            console.log(JSON.stringify(result, null, 2));
        else if (result.valid)
            console.log("OK — 유효한 IR입니다.");
        else
            for (const d of result.diagnostics)
                console.error(`${d.path}: ${d.message}`);
        process.exit(result.valid ? 0 : 1);
    }

    if (cmd === "render") {
        const result = validateIr(ir);
        if (!result.valid) {
            console.error("검증 실패 — render 전에 validate를 통과해야 합니다.");
            for (const d of result.diagnostics)
                console.error(`${d.path}: ${d.message}`);
            process.exit(1);
        }
        writeFileSync(join(dir, `${name}.md`), buildMarkdown(ir, name));
        writeFileSync(join(dir, `${name}.svg`), buildSvg(ir));
        console.log(`생성됨: ${join(dir, name)}.{md,svg}`);
        process.exit(0);
    }

    console.error(`알 수 없는 명령: ${cmd}`);
    process.exit(1);
}

main();
