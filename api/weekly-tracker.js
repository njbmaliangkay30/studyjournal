// /api/weekly-tracker.js
// Sinkronisasi data belajar berdasarkan USERNAME.
//
// Kolom WAJIB di Notion Weekly Tracker DB:
//   Name          → title
//   Username      → rich_text  ← kunci sinkronisasi
//   Range Date    → date (range)
//   Block Start   → rich_text
//   Weekly Target → number
//   Nilai Ujian   → number
//
// Kolom OPSIONAL (kalau ada akan diisi, kalau tidak ada diabaikan):
//   PPT Dots      → rich_text  (JSON)
//   Moods         → rich_text  (JSON)

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
function makeTitle(text)           { return { title:     [{ text: { content: String(text).slice(0, 2000) } }] }; }
function makeRichText(text)        { return { rich_text: [{ text: { content: String(text).slice(0, 1999) } }] }; }
function makeNumber(n)             { return { number: typeof n === "number" ? n : 0 }; }
function makeDate(iso)             { return { date: { start: iso } }; }
function makeDateRange(s, e)       { return { date: { start: s, end: e } }; }
function makeRelation(id)          { return { relation: [{ id }] }; }
function safeJson(obj)             { try { return JSON.stringify(obj ?? {}).slice(0, 1999); } catch { return "{}"; } }

// ── Ambil schema DB untuk tahu kolom apa saja yang ada ───────────────────────
async function getDbSchema() {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}`, {
      headers: notionHeaders(),
    });
    if (!r.ok) return {};
    const d = await r.json();
    return d.properties ?? {};
  } catch { return {}; }
}

// ── Kirim PATCH/POST ke Notion, tangkap error property tidak ada ──────────────
async function notionUpsert(pageId, props, parentProps) {
  // Coba dengan props lengkap dulu
  const body = pageId
    ? JSON.stringify({ properties: props })
    : JSON.stringify({ parent: { database_id: WEEKLY_DB_ID }, properties: { ...parentProps, ...props } });

  const url    = pageId ? `https://api.notion.com/v1/pages/${pageId}` : "https://api.notion.com/v1/pages";
  const method = pageId ? "PATCH" : "POST";

  let r = await fetch(url, { method, headers: notionHeaders(), body });
  let d = await r.json();

  // Kalau gagal karena kolom tidak ada, coba tanpa kolom opsional
  if (!r.ok && (d.message?.includes("not a property") || d.message?.includes("validation"))) {
    const safeProps = Object.fromEntries(
      Object.entries(props).filter(([k]) => !["PPT Dots", "Moods"].includes(k))
    );
    const safeBody = pageId
      ? JSON.stringify({ properties: safeProps })
      : JSON.stringify({ parent: { database_id: WEEKLY_DB_ID }, properties: { ...parentProps, ...safeProps } });
    r = await fetch(url, { method, headers: notionHeaders(), body: safeBody });
    d = await r.json();
  }

  return { ok: r.ok, status: r.status, data: d };
}

// =============================================================================
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !WEEKLY_DB_ID) {
    return res.status(500).json({
      error: "NOTION_TOKEN atau NOTION_WEEKLY_DB_ID belum diset di Vercel Environment Variables.",
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET /api/weekly-tracker?username=xxx
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === "GET") {
    const username = (req.query.username ?? "").trim();
    const blockName = (req.query.blockName ?? "").trim();

    if (!username || !blockName) return res.status(400).json({ error: "Username dan BlockName wajib ada." });

    try {
      const qr = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`, {
        method: "POST", headers: notionHeaders(),
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Username", rich_text: { equals: username } },
              { property: "Topik Blok", rich_text: { equals: blockName } }
            ]
          },
          page_size: 1,
        }),
      });
      const qd = await qr.json();
      const page = qd.results?.[0] ?? null;
      if (!page) return res.json({ found: false });

      const p = page.properties;

      // Tarik data harian (slides)
      let slides = {};
      if (DAILY_DB_ID) {
        const dr = await fetch(`https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({
            filter: { property: "Weekly Tracker", relation: { contains: page.id } },
          }),
        });
        if (dr.ok) {
          const dd = await dr.json();
          for (const e of dd.results ?? []) {
            const dt = e.properties["Date"]?.date?.start || "";
            const cnt = e.properties["Total Slide"]?.number || 0;
            if (dt) slides[dt] = cnt;
          }
        }
      }

      return res.json({
        found: true,
        pageId: page.id,
        target: getNumber(p, "Weekly Target"),
        nilaiUjian: getNumber(p, "Nilai Ujian"),
        blockStart: p["Range Date"]?.date?.start || "",
        blockEnd: p["Range Date"]?.date?.end || "",
        pptDots: getText(p, "PPT Dots"),
        moods: getText(p, "Moods"),
        blockName: getText(p, "Topik Blok"),
        slides: slides
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POST /api/weekly-tracker
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === "POST") {
    const {
      username   = "",
      blockName  = "",
      target     = 0,
      blockStart = "",
      blockEnd   = "",
      nilaiUjian = 0,
      slides     = {},
      pptDots    = [],
      moods      = {},
      pageId     = null,
      slideDate  = null,
    } = req.body ?? {};

    if (!username) return res.status(400).json({ error: "Field 'username' wajib diisi." });

    try {
      // 1. Susun data inti (Termasuk mengupdate Judul/Name secara otomatis)
      const coreProps = {
        "Name":          makeTitle(`${username} — ${blockName}`),
        "Weekly Target": makeNumber(target),
        "Nilai Ujian":   makeNumber(nilaiUjian),
        "Username":      makeRichText(username),
        "Topik Blok":    makeRichText(blockName),
        "PPT Dots":      makeRichText(safeJson(pptDots)),
        "Moods":         makeRichText(safeJson(moods))
      };

      // Cegah error Notion dengan hanya memasukkan Range Date jika tanggalnya ada
      if (blockStart && blockEnd) {
        coreProps["Range Date"] = makeDateRange(blockStart, blockEnd);
      }

      let blockPageId = pageId;

      if (blockPageId) {
        // Jika sudah punya ID, langsung update baris tersebut
        const { ok, status, data } = await notionUpsert(blockPageId, coreProps, null);
        if (!ok) return res.status(status).json({ error: data.message ?? "Notion PATCH error" });
      } else {
        // 2. KUNCI PENTING: Cari baris berdasarkan Username DAN Topik Blok
        const cr = await fetch(`https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({
            filter: {
              and: [
                { property: "Username", rich_text: { equals: username } },
                { property: "Topik Blok", rich_text: { equals: blockName } }
              ]
            },
            page_size: 1
          })
        });
        const cd = await cr.json();
        const existing = cd.results?.[0] ?? null;

        if (existing) {
          // Jika topik sudah ada, update baris tersebut
          blockPageId = existing.id;
          const { ok, status, data } = await notionUpsert(blockPageId, coreProps, null);
          if (!ok) return res.status(status).json({ error: data.message ?? "Notion PATCH error" });
        } else {
          // Jika topik belum ada, BUAT BARIS BARU!
          const { ok, status, data } = await notionUpsert(null, coreProps, {});
          if (!ok) return res.status(status).json({ error: data.message ?? "Notion POST error" });
          blockPageId = data.id;
        }
      }

      // 3. Upsert Daily Log (Otomatis jalan setelah Weekly Tracker sukses)
      if (DAILY_DB_ID && slideDate && blockPageId) {
        const slideCount = slides[slideDate] ?? 0;

        const er = await fetch(`https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`, {
          method: "POST", headers: notionHeaders(),
          body: JSON.stringify({
            filter: {
              and: [
                { property: "Weekly Tracker", relation: { contains: blockPageId } },
                { property: "Date",           date:     { equals: slideDate } },
              ],
            },
            page_size: 1,
          }),
        });

        let dailyPageId = null;
        if (er.ok) { const ed = await er.json(); dailyPageId = ed.results?.[0]?.id ?? null; }

        const dailyProps = {
          "Total Slide":    makeNumber(slideCount),
          Date:             makeDate(slideDate),
          "Weekly Tracker": makeRelation(blockPageId),
        };

        if (dailyPageId) {
          await fetch(`https://api.notion.com/v1/pages/${dailyPageId}`, {
            method: "PATCH", headers: notionHeaders(), body: JSON.stringify({ properties: dailyProps }),
          });
        } else {
          const label = new Date(slideDate + "T12:00:00").toLocaleDateString("id-ID", {
            weekday: "long", day: "numeric", month: "long",
          });
          await fetch("https://api.notion.com/v1/pages", {
            method: "POST", headers: notionHeaders(),
            body: JSON.stringify({
              parent:     { database_id: DAILY_DB_ID },
              properties: { ...dailyProps, Name: makeTitle(`${label} — ${username}`) },
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
