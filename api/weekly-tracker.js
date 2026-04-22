// /api/weekly-tracker.js  —  FIXED v2
//
// Perubahan dari versi sebelumnya:
//  - Kolom "Block Start" (rich_text) DIHAPUS dari Notion → tidak ditulis lagi
//  - blockStart sekarang hanya diambil dari Range Date (date range)
//  - Kunci unik per blok: username + Topik Blok
//    → username sama + Topik Blok berbeda = ROW BARU di Notion (tidak menimpa)
//    → username sama + Topik Blok sama   = UPDATE baris yang sudah ada
//  - notionUpsert retry sekarang juga exclude "Block Start"
//
// Kolom WAJIB di Notion Weekly Tracker DB:
//   Name          → title
//   Username      → rich_text
//   Topik Blok    → rich_text   ← kunci blok
//   Range Date    → date (range)
//   Weekly Target → number
//   Nilai Ujian   → number
//
// Kolom OPSIONAL:
//   PPT Dots      → rich_text  (JSON string)
//   Moods         → rich_text  (JSON string)

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const WEEKLY_DB_ID   = process.env.NOTION_WEEKLY_DB_ID;
const DAILY_DB_ID    = process.env.NOTION_DAILY_DB_ID;
const FLASHCARD_DB_ID = process.env.NOTION_FLASHCARD_DB_ID;
const NOTION_VERSION = "2022-06-28";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function getText(props, key)   { return props[key]?.rich_text?.[0]?.plain_text ?? ""; }
function getNumber(props, key) { return props[key]?.number ?? 0; }
function makeTitle(t)          { return { title:     [{ text: { content: String(t).slice(0, 2000) } }] }; }
function makeRichText(t)       { return { rich_text: [{ text: { content: String(t ?? "").slice(0, 1999) } }] }; }
function makeNumber(n)         { return { number: typeof n === "number" ? n : 0 }; }
function makeDate(iso)         { return { date: { start: iso } }; }
function makeDateRange(s, e)   { return { date: { start: s, end: e } }; }
function makeRelation(id)      { return { relation: [{ id }] }; }
function safeJson(obj)         { try { return JSON.stringify(obj ?? {}).slice(0, 1999); } catch { return "{}"; } }

// Kolom opsional — kalau tidak ada di DB, retry tanpa mereka
const OPTIONAL_COLS = ["PPT Dots", "Moods", "Block Start"];

async function notionUpsert(pageId, props, createExtras) {
  const url    = pageId ? `https://api.notion.com/v1/pages/${pageId}` : "https://api.notion.com/v1/pages";
  const method = pageId ? "PATCH" : "POST";
  const bodyObj = pageId
    ? { properties: props }
    : { parent: { database_id: WEEKLY_DB_ID }, properties: { ...createExtras, ...props } };

  let r = await fetch(url, { method, headers: notionHeaders(), body: JSON.stringify(bodyObj) });
  let d = await r.json();

  if (!r.ok && (d.message?.includes("not a property") || d.message?.includes("validation"))) {
    console.warn("[notion-upsert] Retry tanpa kolom opsional:", d.message);
    const safeProps = Object.fromEntries(
      Object.entries(props).filter(([k]) => !OPTIONAL_COLS.includes(k))
    );
    const safeBody = pageId
      ? { properties: safeProps }
      : { parent: { database_id: WEEKLY_DB_ID }, properties: { ...createExtras, ...safeProps } };
    r = await fetch(url, { method, headers: notionHeaders(), body: JSON.stringify(safeBody) });
    d = await r.json();
  }
  return { ok: r.ok, status: r.status, data: d };
}

async function fetchSlides(pageId) {
  if (!DAILY_DB_ID || !pageId) return {};
  const dr = await fetch(`https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`, {
    method: "POST", headers: notionHeaders(),
    body: JSON.stringify({
      filter: { property: "Weekly Tracker", relation: { contains: pageId } },
      page_size: 100,
    }),
  });
  if (!dr.ok) return {};
  const dd = await dr.json();
  const slides = {};
  for (const e of dd.results ?? []) {
    const dt  = e.properties["Date"]?.date?.start || "";
    const cnt = e.properties["Total Slide"]?.number || 0;
    if (dt && cnt > 0) slides[dt] = cnt;
  }
  return slides;
}

async function fetchFlashcards(blockPageId) {
  if (!FLASHCARD_DB_ID || !blockPageId) return { flashcards: [], difficultCards: [] };
  const flashcards = [];
  const difficultCards = [];
  let cursor = undefined;
  do {
    const body = {
      filter: { property: "Weekly Tracker", relation: { contains: blockPageId } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${FLASHCARD_DB_ID}/query`, {
      method: "POST", headers: notionHeaders(), body: JSON.stringify(body),
    });
    if (!r.ok) break;
    const d = await r.json();
    for (const page of d.results ?? []) {
      const p = page.properties;
      const cardId = p["Card ID"]?.rich_text?.[0]?.plain_text ?? "";
      const q      = p["Question"]?.rich_text?.[0]?.plain_text ?? "";
      const a      = p["Answer"]?.rich_text?.[0]?.plain_text ?? "";
      const isDiff     = p["Is Difficult"]?.checkbox ?? false;
      const updatedAt  = p["Updated At"]?.number ?? 0;
      if (cardId) {
        flashcards.push({ id: cardId, q, a, updatedAt });
        if (isDiff) difficultCards.push(cardId);
      }
    }
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return { flashcards, difficultCards };
}

function pageToData(page) {
  const p          = page.properties;
  const target     = getNumber(p, "Weekly Target") || 30;
  const nilaiUjian = getNumber(p, "Nilai Ujian");
  const blockName  = getText(p, "Topik Blok");
  // blockStart & blockEnd sekarang HANYA dari Range Date
  const blockStart = p["Range Date"]?.date?.start || "";
  const blockEnd   = p["Range Date"]?.date?.end   || p["Range Date"]?.date?.start || "";
  let pptDots = [], moods = {};
  try { const r = getText(p, "PPT Dots"); if (r) pptDots = JSON.parse(r); } catch {}
  try { const r = getText(p, "Moods");    if (r) moods   = JSON.parse(r); } catch {}
  return { target, nilaiUjian, blockStart, blockEnd, blockName, pptDots, moods, pageId: page.id };
}

async function upsertFlashcards(blockPageId, flashcards, difficultCards) {
  if (!FLASHCARD_DB_ID || !blockPageId) return;

  // Ambil semua kartu yang sudah ada di Notion untuk blok ini
  const existing = {};
  let cursor = undefined;
  do {
    const body = {
      filter: { property: "Weekly Tracker", relation: { contains: blockPageId } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${FLASHCARD_DB_ID}/query`, {
      method: "POST", headers: notionHeaders(), body: JSON.stringify(body),
    });
    if (!r.ok) break;
    const d = await r.json();
    for (const page of d.results ?? []) {
      const cardId = page.properties["Card ID"]?.rich_text?.[0]?.plain_text ?? "";
      if (cardId) existing[cardId] = page.id;
    }
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);

  const difficultSet = new Set(difficultCards ?? []);
  const requestedIds = new Set((flashcards ?? []).map(c => String(c.id ?? "")));

  // Upsert setiap kartu
  for (const card of flashcards ?? []) {
    const cardId = String(card.id ?? "");
    const props = {
      "Card ID":        makeRichText(cardId),
      "Question":       makeRichText(String(card.q ?? "").slice(0, 1999)),
      "Answer":         makeRichText(String(card.a ?? "").slice(0, 1999)),
      "Is Difficult":   { checkbox: difficultSet.has(cardId) },
      "Updated At":     { number: typeof card.updatedAt === "number" ? card.updatedAt : Date.now() },
      "Weekly Tracker": makeRelation(blockPageId),
    };

    if (existing[cardId]) {
      // Update kartu yang sudah ada
      await fetch(`https://api.notion.com/v1/pages/${existing[cardId]}`, {
        method: "PATCH", headers: notionHeaders(),
        body: JSON.stringify({ properties: props }),
      });
    } else {
      // Buat kartu baru
      await fetch("https://api.notion.com/v1/pages", {
        method: "POST", headers: notionHeaders(),
        body: JSON.stringify({
          parent: { database_id: FLASHCARD_DB_ID },
          properties: { ...props, Name: makeTitle(String(card.q ?? "").slice(0, 100)) },
        }),
      });
    }
  }

  // Archive kartu yang sudah dihapus user (ada di Notion tapi tidak ada di request)
  for (const [cardId, notionPageId] of Object.entries(existing)) {
    if (!requestedIds.has(cardId)) {
      await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
        method: "PATCH", headers: notionHeaders(),
        body: JSON.stringify({ archived: true }),
      });
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !WEEKLY_DB_ID) {
    return res.status(500).json({ error: "NOTION_TOKEN atau NOTION_WEEKLY_DB_ID belum diset." });
  }

  // GET
  if (req.method === "GET") {
    const username  = (req.query.username  ?? "").trim();
    const blockName = (req.query.blockName ?? "").trim();
    const history   = req.query.history === "true";
    if (!username) return res.status(400).json({ error: "Parameter ?username= wajib diisi." });
    try {

      // ── HISTORY MODE: kembalikan SEMUA blok milik username ini ──────────────
      if (history) {
        const hr = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({
            filter: { property: "Username", rich_text: { equals: username } },
            sorts:  [{ property: "Range Date", direction: "descending" }],
            page_size: 100,
          }),
        });
        const hd = await hr.json();
        if (!hr.ok) return res.status(hr.status).json({ error: hd.message ?? "Notion query error" });
        const blocks = (hd.results ?? []).map(pageToData);
        return res.json({ found: blocks.length > 0, blocks });
      }
      // ────────────────────────────────────────────────────────────────────────

      const filter = blockName
        ? { and: [
            { property: "Username",   rich_text: { equals: username  } },
            { property: "Topik Blok", rich_text: { equals: blockName } },
          ]}
        : { property: "Username", rich_text: { equals: username } };

      const qr = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`, {
        method: "POST", headers: notionHeaders(),
        body: JSON.stringify({
          filter,
          sorts: [{ property: "Range Date", direction: "descending" }],
          page_size: 1,
        }),
      });
      const qd = await qr.json();
      if (!qr.ok) return res.status(qr.status).json({ error: qd.message ?? "Notion query error" });

      const page = qd.results?.[0] ?? null;
      if (!page) return res.json({ found: false });

      const data   = pageToData(page);
     const slides = await fetchSlides(page.id);
      const { flashcards, difficultCards } = await fetchFlashcards(page.id);
      data.slides       = slides;
      data.flashcards   = flashcards;
      data.difficultCards = difficultCards;
      return res.json({ found: true, ...data });

    } catch (err) {
      console.error("[GET]", err.message);
      return res.status(500).json({ error: "Gagal mengambil data: " + err.message });
    }
  }

  // POST
  if (req.method === "POST") {
    const username   = String(req.body?.username   ?? "").trim();
    const blockName  = String(req.body?.blockName  ?? "").trim();
    const blockStart = String(req.body?.blockStart ?? "").trim();
    const blockEnd   = String(req.body?.blockEnd   ?? "").trim();
    const target     = Number(req.body?.target)    || 30;
    const nilaiUjian = Number(req.body?.nilaiUjian)|| 0;
    const slides     = req.body?.slides    ?? {};
    const pptDots    = req.body?.pptDots   ?? [];
    const moods      = req.body?.moods     ?? {};
    const pageId     = req.body?.pageId    ?? null;
    const slideDate  = req.body?.slideDate ?? null;
    const forceNew   = req.body?.forceNew  === true;

    if (!username || !blockStart || !blockEnd) {
      const missing = [];
      if (!username)   missing.push("username");
      if (!blockStart) missing.push("blockStart");
      if (!blockEnd)   missing.push("blockEnd");
      console.error("[POST 400]", missing.join(", "), JSON.stringify({ username, blockStart, blockEnd }));
      return res.status(400).json({
        error: `Field wajib kosong: ${missing.join(", ")}`,
        received: { username, blockStart, blockEnd },
      });
    }

    try {
      // Tidak ada "Block Start" di sini — sudah dihapus dari kolom Notion
      const coreProps = {
        "Weekly Target": makeNumber(target),
        "Nilai Ujian":   makeNumber(nilaiUjian),
        "Username":      makeRichText(username),
        "Topik Blok":    makeRichText(blockName || ""),
        "PPT Dots":      makeRichText(safeJson(pptDots)),
        "Moods":         makeRichText(safeJson(moods)),
        "Range Date":    makeDateRange(blockStart, blockEnd),
      };

      const rowTitle   = blockName ? `${username} — ${blockName} (${blockStart})` : `${username} (${blockStart})`;
      const createExtras = { Name: makeTitle(rowTitle) };

      let blockPageId = pageId;

      if (blockPageId && !forceNew) {
        // Sudah ada pageId dan bukan blok baru paksa → langsung PATCH
        const { ok, status, data } = await notionUpsert(blockPageId, coreProps, null);
        if (!ok) {
          console.error("[PATCH]", data.message);
          return res.status(status).json({ error: data.message ?? "Notion PATCH error" });
        }
      } else if (forceNew) {
        // forceNew=true: selalu buat ROW BARU, abaikan pageId dan pencarian existing
        const { ok, status, data } = await notionUpsert(null, coreProps, createExtras);
        if (!ok) {
          console.error("[POST forceNew]", data.message);
          return res.status(status).json({ error: data.message ?? "Notion POST error" });
        }
        blockPageId = data.id;
      } else {
        // Cari berdasarkan username + Topik Blok (kunci unik per blok)
        const searchFilter = blockName
          ? { and: [
              { property: "Username",   rich_text: { equals: username  } },
              { property: "Topik Blok", rich_text: { equals: blockName } },
            ]}
          : { and: [
              { property: "Username",   rich_text: { equals: username  } },
              { property: "Range Date", date:      { on_or_after: blockStart } },
            ]};

        const cr = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({ filter: searchFilter, page_size: 1 }),
        });
        const cd = await cr.json();
        const existing = cd.results?.[0] ?? null;

        if (existing) {
          blockPageId = existing.id;
          const { ok, status, data } = await notionUpsert(blockPageId, coreProps, null);
          if (!ok) {
            console.error("[PATCH existing]", data.message);
            return res.status(status).json({ error: data.message ?? "Notion PATCH error" });
          }
        } else {
          // Blok baru → buat ROW BARU (data blok lama tetap ada)
          const { ok, status, data } = await notionUpsert(null, coreProps, createExtras);
          if (!ok) {
            console.error("[POST new]", data.message);
            return res.status(status).json({ error: data.message ?? "Notion POST error" });
          }
          blockPageId = data.id;
        }
      }

      // Upsert Daily Log
      if (DAILY_DB_ID && slideDate && blockPageId) {
        const cnt = slides[slideDate] ?? 0;
        const er = await fetch(`https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({
            filter: { and: [
              { property: "Weekly Tracker", relation: { contains: blockPageId } },
              { property: "Date",           date:     { equals: slideDate }     },
            ]},
            page_size: 1,
          }),
        });
        let dailyId = null;
        if (er.ok) { const ed = await er.json(); dailyId = ed.results?.[0]?.id ?? null; }

        const dailyProps = {
          "Total Slide":    makeNumber(cnt),
          "Date":           makeDate(slideDate),
          "Weekly Tracker": makeRelation(blockPageId),
        };
        if (dailyId) {
          await fetch(`https://api.notion.com/v1/pages/${dailyId}`, {
            method: "PATCH", headers: notionHeaders(),
            body: JSON.stringify({ properties: dailyProps }),
          });
        } else {
          const lbl = new Date(slideDate + "T12:00:00").toLocaleDateString("id-ID", {
            weekday: "long", day: "numeric", month: "long",
          });
          await fetch("https://api.notion.com/v1/pages", {
            method: "POST", headers: notionHeaders(),
            body: JSON.stringify({
              parent: { database_id: DAILY_DB_ID },
              properties: { ...dailyProps, Name: makeTitle(`${lbl} — ${username}`) },
            }),
          });
        }
      }
// Simpan flashcards ke database terpisah (selalu dijalankan agar kartu yang dihapus bisa di-archive)
      const flashcards    = req.body?.flashcards    ?? [];
      const difficultCards = req.body?.difficultCards ?? [];
      await upsertFlashcards(blockPageId, flashcards, difficultCards);
      return res.json({ success: true, pageId: blockPageId });

    } catch (err) {
      console.error("[POST]", err.message);
      return res.status(500).json({ error: "Gagal menyimpan: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
