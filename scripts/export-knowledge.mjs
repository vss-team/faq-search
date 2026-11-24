/* 노션 지식 내보내기: 운영팀 홈 아래의 모든 페이지와 표(A/S·기능 현황)를 읽어 public/knowledge.json 으로 저장합니다.
   FAQ 표는 faq.json 이 따로 있으므로 제외합니다. */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const { NOTION_TOKEN, NOTION_DB_ID } = process.env;
const HEAD = { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const DELAY = Number(process.env.NOTION_DELAY_MS || 340);   // 노션 요청 속도 제한(초당 약 3회)을 지키기 위한 대기 시간

/* ▼ 이 단어가 제목에 들어간 페이지와 그 하위 페이지는 지식에서 뺍니다. 웹툰도 넣고 싶으면 아래 줄을 [] 로 바꾸세요. */
const EXCLUDE_TITLE_WORDS = ["웹툰"];
const CHUNK_SIZE = 900;       // 한 조각의 최대 글자 수 (넘으면 문단 단위로 나눔)
const MIN_PAGE_CHARS = 30;    // 이보다 짧은 페이지(목차용 빈 페이지 등)는 건너뜀
const MIN_TOTAL_CHUNKS = 50;  // 이보다 적게 나오면 오류로 보고 기존 파일을 덮어쓰지 않음

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (id) => String(id || "").replace(/-/g, "");
const plain = (arr = []) => arr.map((t) => t.plain_text || "").join("");

async function api(path, opts = {}) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch("https://api.notion.com/v1" + path, { headers: HEAD, ...opts });
    if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 2) * 1000); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    await sleep(DELAY);
    return res.json();
  }
  throw new Error("요청 제한에 계속 걸렸습니다");
}

async function searchAll() {
  const out = []; let cursor;
  do {
    const r = await api("/search", { method: "POST", body: JSON.stringify({ page_size: 100, start_cursor: cursor }) });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out.filter((i) => !i.archived && !i.in_trash);
}

function titleOf(item) {
  if (item.object === "database") return plain(item.title) || "(제목 없음)";
  const t = Object.values(item.properties || {}).find((p) => p.type === "title");
  return (t && plain(t.title)) || "(제목 없음)";
}

function propText(p) {
  switch (p.type) {
    case "rich_text": return plain(p.rich_text);
    case "number": return p.number == null ? "" : String(p.number);
    case "select": return (p.select && p.select.name) || "";
    case "status": return (p.status && p.status.name) || "";
    case "multi_select": return p.multi_select.map((s) => s.name).join(", ");
    case "checkbox": return p.checkbox ? "O" : "X";
    case "url": return p.url || "";
    case "phone_number": return p.phone_number || "";
    case "email": return p.email || "";
    case "date": return (p.date && p.date.start) || "";
    default: return "";
  }
}

/* 페이지 본문을 글로 바꿉니다(하위 블록 포함). 이미지는 개수만 셉니다. */
async function bodyText(id) {
  const lines = []; let images = 0;
  async function walk(blockId) {
    let cursor;
    do {
      const r = await api(`/blocks/${blockId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : ""));
      for (const b of r.results) {
        const body = b[b.type] || {};
        const t = plain(body.rich_text);
        switch (b.type) {
          case "heading_1": case "heading_2": case "heading_3": if (t) lines.push("\n## " + t); break;
          case "bulleted_list_item": case "numbered_list_item": case "to_do": if (t) lines.push("- " + t); break;
          case "table_row": lines.push((body.cells || []).map((c) => plain(c)).join(" | ")); break;
          case "image": case "file": case "pdf": case "video":
            images++; if (plain(body.caption)) lines.push("(그림 설명) " + plain(body.caption)); break;
          case "child_page": case "child_database": break;
          default: if (t) lines.push(t);
        }
        if (b.has_children && b.type !== "child_page" && b.type !== "child_database") await walk(b.id);
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
  }
  await walk(id);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), images };
}

function split(text) {
  if (text.length <= CHUNK_SIZE) return [text];
  const out = []; let cur = "";
  for (const para of text.split(/\n(?=\S)/)) {
    if ((cur + "\n" + para).length > CHUNK_SIZE && cur) { out.push(cur); cur = ""; }
    let rest = para;
    while (rest.length > CHUNK_SIZE) { out.push(rest.slice(0, CHUNK_SIZE)); rest = rest.slice(CHUNK_SIZE); }
    cur = cur ? cur + "\n" + rest : rest;
  }
  if (cur) out.push(cur);
  return out;
}

const items = await searchAll();
const dbs = items.filter((i) => i.object === "database");
const pages = items.filter((i) => i.object === "page");
const byId = new Map(pages.map((p) => [norm(p.id), p]));
const dbTitle = new Map(dbs.map((d) => [norm(d.id), titleOf(d)]));
const faqDb = norm(NOTION_DB_ID);

function chain(p) {
  const out = []; let cur = p, guard = 0;
  while (cur && guard++ < 12) {
    out.unshift(titleOf(cur));
    const par = cur.parent || {};
    if (par.type === "page_id") cur = byId.get(norm(par.page_id));
    else if (par.type === "database_id") { out.unshift(dbTitle.get(norm(par.database_id)) || "표"); break; }
    else break;
  }
  if (out[0] === "운영팀 홈") out.shift();
  return out;
}

const chunks = []; const skipped = { 제외: 0, 짧음: 0, FAQ행: 0, 읽기실패: [] };
for (const p of pages) {
  const isRow = p.parent && p.parent.type === "database_id";
  if (isRow && norm(p.parent.database_id) === faqDb) { skipped.FAQ행++; continue; }
  const path = chain(p);
  if (path.some((t) => EXCLUDE_TITLE_WORDS.some((w) => t.includes(w)))) { skipped.제외++; continue; }
  try {
    const { text, images } = await bodyText(p.id);
    let full = text;
    if (isRow) {
      const props = Object.entries(p.properties || {}).filter(([, v]) => v.type !== "title")
        .map(([k, v]) => [k, propText(v)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
      full = [props.join("\n"), text].filter(Boolean).join("\n");
    }
    if (!isRow && full.length < MIN_PAGE_CHARS) { skipped.짧음++; continue; }
    const parts = split(full);
    parts.forEach((part, i) => chunks.push({
      id: norm(p.id) + (i ? "#" + (i + 1) : ""),
      title: path.join(" > ") + (parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""),
      text: part, kind: isRow ? "row" : "page", images, updated: p.last_edited_time
    }));
  } catch (e) { skipped.읽기실패.push(path.join(" > ") + " — " + String(e.message).slice(0, 80)); }
}

if (chunks.length < MIN_TOTAL_CHUNKS) throw new Error(`조각이 ${chunks.length}개뿐입니다. 안전을 위해 기존 파일을 유지합니다.`);
chunks.sort((a, b) => a.title.localeCompare(b.title, "ko") || a.id.localeCompare(b.id));
mkdirSync("public", { recursive: true });
writeFileSync("public/knowledge.json", "[\n" + chunks.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n");

const total = chunks.reduce((n, c) => n + c.text.length, 0);
const big = chunks.slice().sort((a, b) => b.text.length - a.text.length).slice(0, 5);
const md = [
  "## 지식 내보내기 결과", "",
  `조각 ${chunks.length}개 (페이지 ${chunks.filter((c) => c.kind === "page").length}, 표 행 ${chunks.filter((c) => c.kind === "row").length}), 글자 합계 약 ${total.toLocaleString()}자`,
  `건너뜀: 제외 단어 ${skipped.제외}개, 너무 짧음 ${skipped.짧음}개, FAQ 행 ${skipped.FAQ행}개, 읽기 실패 ${skipped.읽기실패.length}개`,
  ...(skipped.읽기실패.length ? ["", "읽기 실패 목록:", ...skipped.읽기실패.map((s) => "- " + s)] : []),
  "", "가장 긴 조각 5개:", ...big.map((c) => `- ${c.title} (${c.text.length}자)`)
].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
