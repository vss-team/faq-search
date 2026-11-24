import { writeFileSync, mkdirSync } from "node:fs";

const { NOTION_TOKEN, NOTION_DB_ID } = process.env;
const headers = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

const txt = (arr = []) => arr.map((t) => t.plain_text).join("");

function read(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": return txt(p.title);
    case "rich_text": return txt(p.rich_text);
    case "number": return p.number;
    case "select": return p.select?.name ?? null;
    case "multi_select": return p.multi_select.map((s) => s.name);
    case "checkbox": return p.checkbox;
    default: return null;
  }
}

async function fetchAll() {
  const pages = [];
  let cursor;
  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          page_size: 100,
          start_cursor: cursor,
          filter: { property: "노출여부", checkbox: { equals: true } },
        }),
      }
    );
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

const pages = await fetchAll();
const items = pages.map((pg) => {
  const p = pg.properties;
  const titleProp = Object.values(p).find((v) => v.type === "title");
  return {
    id: pg.id,
    question: read(titleProp),
    answer: read(p["답변"]),
    models: read(p["단말기 종류"]) ?? [],
    type: read(p["문의 유형"]),
    importance: read(p["중요도"]),
    category: read(p["카테고리"]),
    keywords: read(p["검색 키워드"]),
    freq: read(p["문의 빈도"]) ?? 0,
    updated: pg.last_edited_time,
  };
});

mkdirSync("public", { recursive: true });
writeFileSync("public/faq.json", JSON.stringify(items, null, 1));
console.log(`exported ${items.length} FAQs`);
