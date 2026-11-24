/* 노션 현황 조사: 연결(FAQ_API)이 읽을 수 있는 페이지와 데이터베이스를 나열하고 분량을 셉니다.
   아무것도 바꾸거나 저장하지 않고, 결과는 실행 화면(Summary)에만 표시됩니다. */
import { appendFileSync } from "node:fs";

const TOKEN = process.env.NOTION_TOKEN;
const HEAD = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const MAX_CALLS = 400;   // 분량을 세기 위해 쓰는 노션 요청 수의 상한
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  for (let i = 0; i < 6; i++) {
    calls++;
    const res = await fetch("https://api.notion.com/v1" + path, { headers: HEAD, ...opts });
    if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 2) * 1000); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    await sleep(340);   // 노션 요청 속도 제한(초당 약 3회)을 지키기 위해 쉬어 줍니다
    return res.json();
  }
  throw new Error("요청 제한에 계속 걸렸습니다");
}

const plain = (arr = []) => arr.map((t) => t.plain_text || "").join("");

async function searchAll() {
  const out = []; let cursor;
  do {
    const r = await api("/search", { method: "POST", body: JSON.stringify({ page_size: 100, start_cursor: cursor }) });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

function titleOf(item) {
  if (item.object === "database") return plain(item.title) || "(제목 없음)";
  const t = Object.values(item.properties || {}).find((p) => p.type === "title");
  return t ? plain(t.title) || "(제목 없음)" : "(제목 없음)";
}

/* 페이지 본문의 글자 수와 이미지·파일 개수를 셉니다(하위 블록 포함). */
async function measure(blockId) {
  let chars = 0, media = 0, tables = 0, capped = false;
  async function walk(id) {
    let cursor;
    do {
      if (calls >= MAX_CALLS) { capped = true; return; }
      const r = await api(`/blocks/${id}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : ""));
      for (const b of r.results) {
        const body = b[b.type] || {};
        chars += plain(body.rich_text).length + plain(body.caption).length;
        if (["image", "file", "pdf", "video"].includes(b.type)) media++;
        if (b.type === "table") tables++;
        if (b.type === "table_row") chars += (body.cells || []).flat().map((c) => c.plain_text || "").join("").length;
        if (b.has_children && b.type !== "child_page" && b.type !== "child_database") await walk(b.id);
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
  }
  await walk(blockId);
  return { chars, media, tables, capped };
}

const items = await searchAll();
const dbs = items.filter((i) => i.object === "database");
const pages = items.filter((i) => i.object === "page");
const isRow = (p) => p.parent && p.parent.type === "database_id";
const rowsByDb = new Map();
pages.filter(isRow).forEach((p) => rowsByDb.set(p.parent.database_id, (rowsByDb.get(p.parent.database_id) || 0) + 1));
const standalone = pages.filter((p) => !isRow(p));
const dbTitle = new Map(dbs.map((d) => [d.id, titleOf(d)]));

const lines = [];
lines.push("## 노션 현황 조사", "", `연결이 읽을 수 있는 항목: 페이지 ${standalone.length}개, 데이터베이스 ${dbs.length}개, 데이터베이스 행 ${pages.length - standalone.length}개`, "");
lines.push("### 데이터베이스", "", "| 이름 | 행(문서) 수 |", "|---|---|");
dbs.forEach((d) => lines.push(`| ${titleOf(d)} | ${rowsByDb.get(d.id) || 0} |`));
const orphanRows = [...rowsByDb.entries()].filter(([id]) => !dbTitle.has(id));
orphanRows.forEach(([id, n]) => lines.push(`| (목록에 없는 데이터베이스 ${id.slice(0, 8)}…) | ${n} |`));
lines.push("", "### 일반 페이지 (본문 분량)", "", "| 제목 | 글자 수 | 이미지·파일 | 표 | 마지막 수정 |", "|---|---|---|---|---|");
let total = 0;
for (const p of standalone) {
  const m = await measure(p.id);
  total += m.chars;
  lines.push(`| ${titleOf(p)} | ${m.chars.toLocaleString()}${m.capped ? "+" : ""} | ${m.media} | ${m.tables} | ${String(p.last_edited_time).slice(0, 10)} |`);
}
lines.push("", `일반 페이지 글자 수 합계: 약 ${total.toLocaleString()}자 (노션 요청 ${calls}회 사용${calls >= MAX_CALLS ? ", 상한에 도달해 일부는 덜 센 값입니다" : ""})`);
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
