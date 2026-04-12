// /api/weekly-tracker.js
//
// Kolom WAJIB di Notion Weekly Tracker DB:
//   Name          → title
//   Username      → rich_text  ← kunci sinkronisasi
//   Range Date    → date (range)
//   Block Start   → rich_text
//   Topik Blok    → rich_text  ← nama blok (misal "Anatomi Reproduksi Pria")
//   Weekly Target → number
//   Nilai Ujian   → number
//
// Kolom OPSIONAL (kalau ada akan diisi, kalau tidak ada diabaikan):
//   PPT Dots      → rich_text  (JSON string)
//   Moods         → rich_text  (JSON string)

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const WEEKLY_DB_ID   = process.env.NOTION_WEEKLY_DB_ID;
const DAILY_DB_ID    = process.env.NOTION_DAILY_DB_ID;
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
function makeTitle(t)          { return { title:     [{ text: { content: String(t).slice(0,2000) } }] }; }
function makeRichText(t)       { return { rich_text: [{ text: { content: String(t).slice(0,1999) } }] }; }
function makeNumber(n)         { return { number: typeof n === "number" ? n : 0 }; }
function makeDate(iso)         { return { date: { start: iso } }; }
function makeDateRange(s, e)   { return { date: { start: s, end: e } }; }
function makeRelation(id)      { return { relation: [{ id }] }; }
function safeJson(obj)         { try { return JSON.stringify(obj ?? {}).slice(0,1999); } catch { return "{}"; } }

// Upsert dengan fallback: kalau gagal karena kolom opsional, coba tanpa mereka
async function notionUpsert(pageId, props, createExtras) {
  const url    = pageId ? `https://api.notion.com/v1/pages/${pageId}` : "https://api.notion.com/v1/pages";
  const method = pageId ? "PATCH" : "POST";
  const bodyObj = pageId
    ? { properties: props }
    : { parent: { database_id: WEEKLY_DB_ID }, properties: { ...createExtras, ...props } };

  let r = await fetch(url, { method, headers: notionHeaders(), body: JSON.stringify(bodyObj) });
  let d = await r.json();

  // Kalau gagal karena kolom opsional tidak ada → retry tanpa kolom itu
  if (!r.ok && (d.message?.includes("not a property") || d.message?.includes("validation"))) {
    const safeProps = Object.fromEntries(
      Object.entries(props).filter(([k]) => !["PPT Dots", "Moods"].includes(k))
    );
    const safeBody = pageId
      ? { properties: safeProps }
      : { parent: { database_id: WEEKLY_DB_ID }, properties: { ...createExtras, ...safeProps } };
    r = await fetch(url, { method, headers: notionHeaders(), body: JSON.stringify(safeBody) });
    d = await r.json();
  }
  return { ok: r.ok, status: r.status, data: d };
}

// Ambil slides dari Daily Log untuk satu page
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

// Serialisasi satu page Notion → object data
function pageToData(page) {
  const p          = page.properties;
  const target     = getNumber(p, "Weekly Target") || 30;
  const nilaiUjian = getNumber(p, "Nilai Ujian");
  const blockStart = getText(p, "Block Start") || p["Range Date"]?.date?.start || "";
  const blockEnd   = p["Range Date"]?.date?.end || p["Range Date"]?.date?.start || "";
  const blockName  = getText(p, "Topik Blok");
  let pptDots = [], moods = {};
  try { const r = getText(p, "PPT Dots"); if (r) pptDots = JSON.parse(r); } catch {}
  try { const r = getText(p, "Moods");    if (r) moods   = JSON.parse(r); } catch {}
  return { target, nilaiUjian, blockStart, blockEnd, blockName, pptDots, moods, pageId: page.id };
}

// =============================================================================
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !WEEKLY_DB_ID) {
    return res.status(500).json({ error: "NOTION_TOKEN atau NOTION_WEEKLY_DB_ID belum diset di Vercel." });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/weekly-tracker?username=xxx
  // GET /api/weekly-tracker?username=xxx&blockName=yyy  (spesifik 1 blok)
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === "GET") {
    const username  = (req.query.username  ?? "").trim();
    const blockName = (req.query.blockName ?? "").trim();

    if (!username) return res.status(400).json({ error: "Parameter ?username= wajib diisi." });

    try {
      // Filter: selalu pakai username. Kalau ada blockName, tambahkan filter itu.
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
      if (!page) return res.json({ found: false, data: null });

      const data   = pageToData(page);
      const slides = await fetchSlides(page.id);
      data.slides  = slides;

      return res.json({ found: true, pageId: page.id, ...data });

    } catch (err) {
      return res.status(500).json({ error: "Gagal mengambil data: " + err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/weekly-tracker — simpan / buat blok
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === "POST") {
    const {
      username   = "",
      blockName  = "",
      target     = 30,
      blockStart = "",
      blockEnd   = "",
      nilaiUjian = 0,
      slides     = {},
      pptDots    = [],
      moods      = {},
      pageId     = null,
      slideDate  = null,
    } = req.body ?? {};

    if (!username)                return res.status(400).json({ error: "'username' wajib diisi." });
    if (!blockStart || !blockEnd) return res.status(400).json({ error: "'blockStart' dan 'blockEnd' wajib diisi." });

    try {
      const coreProps = {
        "Weekly Target": makeNumber(target),
        "Nilai Ujian":   makeNumber(nilaiUjian),
        "Username":      makeRichText(username),
        "Block Start":   makeRichText(blockStart),
        "Topik Blok":    makeRichText(blockName || ""),
        "PPT Dots":      makeRichText(safeJson(pptDots)),
        "Moods":         makeRichText(safeJson(moods)),
        "Range Date":    makeDateRange(blockStart, blockEnd),
      };

      const createExtras = {
        Name: makeTitle(`${username}${blockName ? " — " + blockName : ""} (${blockStart})`),
      };

      let blockPageId = pageId;

      if (blockPageId) {
        // Sudah punya pageId → langsung PATCH
        const { ok, status, data } = await notionUpsert(blockPageId, coreProps, null);
        if (!ok) return res.status(status).json({ error: data.message ?? "Notion PATCH error" });

      } else {
        // Cari baris berdasarkan username + blockName (kalau blockName ada)
        // Atau cari berdasarkan username + range tanggal (supaya tidak duplikat)
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
          if (!ok) return res.status(status).json({ error: data.message ?? "Notion PATCH error" });
        } else {
          const { ok, status, data } = await notionUpsert(null, coreProps, createExtras);
          if (!ok) return res.status(status).json({ error: data.message ?? "Notion POST error" });
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
          Date:             makeDate(slideDate),
          "Weekly Tracker": makeRelation(blockPageId),
        };
        if (dailyId) {
          await fetch(`https://api.notion.com/v1/pages/${dailyId}`, {
            method: "PATCH", headers: notionHeaders(), body: JSON.stringify({ properties: dailyProps }),
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

      return res.json({ success: true, pageId: blockPageId });

    } catch (err) {
      return res.status(500).json({ error: "Gagal menyimpan: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
