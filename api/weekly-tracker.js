// /api/weekly-tracker.js
// Sinkronisasi data belajar berdasarkan USERNAME — bukan device.
// Semua device yang login dengan username sama akan berbagi data yang sama.
//
// Notion DB yang dibutuhkan:
//   Weekly Tracker DB  → NOTION_WEEKLY_DB_ID
//     - Name           : title
//     - Username       : rich_text  ← kunci sinkronisasi
//     - Range Date     : date (range: start = blockStart, end = blockEnd)
//     - Block Start    : rich_text
//     - Weekly Target  : number
//     - Nilai Ujian    : number
//     - PPT Dots       : rich_text  (JSON string, maks ~2000 karakter)
//     - Moods          : rich_text  (JSON string)
//
//   Daily Log DB       → NOTION_DAILY_DB_ID  (opsional, untuk detail per hari)
//     - Name           : title
//     - Date           : date
//     - Total Slide    : number
//     - Weekly Tracker : relation → Weekly Tracker DB

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const WEEKLY_DB_ID   = process.env.NOTION_WEEKLY_DB_ID;
const DAILY_DB_ID    = process.env.NOTION_DAILY_DB_ID;   // boleh kosong
const NOTION_VERSION = "2022-06-28";

function notionHeaders() {
  return {
    Authorization:  `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// ── Notion property helpers ───────────────────────────────────────────────────
function getText(props, key) {
  return props[key]?.rich_text?.[0]?.plain_text ?? "";
}
function getNumber(props, key) {
  return props[key]?.number ?? 0;
}
function getTitle(props, key = "Name") {
  return props[key]?.title?.[0]?.plain_text ?? "";
}
function makeTitle(text)           { return { title:     [{ text: { content: String(text).slice(0, 2000) } }] }; }
function makeRichText(text)        { return { rich_text: [{ text: { content: String(text).slice(0, 2000) } }] }; }
function makeNumber(n)             { return { number: typeof n === "number" ? n : 0 }; }
function makeDate(iso)             { return { date: { start: iso } }; }
function makeDateRange(start, end) { return { date: { start, end } }; }
function makeRelation(pageId)      { return { relation: [{ id: pageId }] }; }

// JSON → safe string (truncated to Notion's 2000-char limit per rich_text block)
function jsonToRichText(obj) {
  const str = JSON.stringify(obj ?? {});
  return makeRichText(str.slice(0, 1999));
}
function richTextToJson(props, key) {
  const raw = getText(props, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !WEEKLY_DB_ID) {
    return res.status(500).json({
      error: "NOTION_TOKEN atau NOTION_WEEKLY_DB_ID belum diset di Environment Variables Vercel.",
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     GET /api/weekly-tracker?username=Revalina
     → Cari baris di Weekly Tracker DB dengan Username = username
     → Kembalikan semua data: blok, target, slides, pptDots, moods
  ══════════════════════════════════════════════════════════════════════════ */
  if (req.method === "GET") {
    const username = (req.query.username ?? "").trim();
    if (!username) {
      return res.status(400).json({ error: "Parameter ?username= wajib diisi." });
    }

    try {
      // 1. Cari baris Weekly Tracker berdasarkan username
      const queryRes = await fetch(
        `https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`,
        {
          method:  "POST",
          headers: notionHeaders(),
          body: JSON.stringify({
            filter: {
              property: "Username",
              rich_text: { equals: username },
            },
            sorts: [{ property: "Range Date", direction: "descending" }],
            page_size: 1,
          }),
        }
      );
      const queryData = await queryRes.json();
      if (!queryRes.ok) {
        return res.status(queryRes.status).json({ error: queryData.message ?? "Notion query error" });
      }

      const page = queryData.results?.[0] ?? null;
      if (!page) {
        // User baru — belum ada data
        return res.json({ found: false, data: null });
      }

      // 2. Baca properti dari baris yang ditemukan
      const p          = page.properties;
      const target     = getNumber(p, "Weekly Target") || 30;
      const nilaiUjian = getNumber(p, "Nilai Ujian");
      const blockStart = getText(p, "Block Start")
                      || p["Range Date"]?.date?.start
                      || "";
      const blockEnd   = p["Range Date"]?.date?.end
                      || p["Range Date"]?.date?.start
                      || "";

      // pptDots & moods disimpan sebagai JSON string di rich_text
      const pptDots = richTextToJson(p, "PPT Dots") ?? [];
      const moods   = richTextToJson(p, "Moods")    ?? {};

      // 3. Ambil slides dari Daily Log (opsional)
      let slides = {};
      if (DAILY_DB_ID) {
        const dailyRes = await fetch(
          `https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`,
          {
            method:  "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              filter:    { property: "Weekly Tracker", relation: { contains: page.id } },
              page_size: 100,
            }),
          }
        );
        if (dailyRes.ok) {
          const dailyData = await dailyRes.json();
          for (const entry of dailyData.results ?? []) {
            const dp      = entry.properties;
            const dateStr = dp["Date"]?.date?.start ?? "";
            const count   = getNumber(dp, "Total Slide");
            if (dateStr && count > 0) slides[dateStr] = count;
          }
        }
      }

      return res.json({
        found: true,
        pageId: page.id,
        data: {
          target,
          nilaiUjian,
          blockStart,
          blockEnd,
          slides,
          pptDots,
          moods,
          pageId: page.id,
        },
      });

    } catch (err) {
      return res.status(500).json({ error: "Gagal mengambil data: " + err.message });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     POST /api/weekly-tracker
     Body: { username, target, blockStart, blockEnd, nilaiUjian,
             slides, pptDots, moods, pageId, slideDate }
     → Upsert baris Weekly Tracker berdasarkan username
     → Upsert Daily Log untuk slideDate (jika ada)
  ══════════════════════════════════════════════════════════════════════════ */
  if (req.method === "POST") {
    const {
      username   = "",
      target     = 30,
      blockStart = "",
      blockEnd   = "",
      nilaiUjian = 0,
      slides     = {},
      pptDots    = [],
      moods      = {},
      pageId     = null,   // kalau sudah punya, langsung PATCH
      slideDate  = null,
    } = req.body ?? {};

    if (!username) {
      return res.status(400).json({ error: "Field 'username' wajib diisi." });
    }
    if (!blockStart || !blockEnd) {
      return res.status(400).json({ error: "Field 'blockStart' dan 'blockEnd' wajib diisi." });
    }

    try {
      // Properti yang selalu di-update
      const weeklyProps = {
        "Weekly Target": makeNumber(target),
        "Nilai Ujian":   makeNumber(nilaiUjian),
        "Username":      makeRichText(username),
        "Block Start":   makeRichText(blockStart),
        "PPT Dots":      jsonToRichText(pptDots),
        "Moods":         jsonToRichText(moods),
      };

      let blockPageId = pageId;

      if (blockPageId) {
        // ── PATCH: update baris yang sudah ada ─────────────────────────────
        const patchRes = await fetch(
          `https://api.notion.com/v1/pages/${blockPageId}`,
          {
            method:  "PATCH",
            headers: notionHeaders(),
            body:    JSON.stringify({ properties: weeklyProps }),
          }
        );
        const patchData = await patchRes.json();
        if (!patchRes.ok) {
          return res.status(patchRes.status).json({ error: patchData.message ?? "Patch error" });
        }

      } else {
        // ── Cek apakah sudah ada baris dengan username ini ─────────────────
        const checkRes = await fetch(
          `https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`,
          {
            method:  "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              filter:    { property: "Username", rich_text: { equals: username } },
              page_size: 1,
            }),
          }
        );
        const checkData = await checkRes.json();
        const existing  = checkData.results?.[0] ?? null;

        if (existing) {
          // ── PATCH existing ────────────────────────────────────────────────
          blockPageId = existing.id;
          await fetch(`https://api.notion.com/v1/pages/${blockPageId}`, {
            method:  "PATCH",
            headers: notionHeaders(),
            body:    JSON.stringify({ properties: weeklyProps }),
          });
        } else {
          // ── CREATE baru ───────────────────────────────────────────────────
          const createRes = await fetch("https://api.notion.com/v1/pages", {
            method:  "POST",
            headers: notionHeaders(),
            body:    JSON.stringify({
              parent:     { database_id: WEEKLY_DB_ID },
              properties: {
                ...weeklyProps,
                Name:         makeTitle(`${username} — Blok ${blockStart} s/d ${blockEnd}`),
                "Range Date": makeDateRange(blockStart, blockEnd),
              },
            }),
          });
          const createData = await createRes.json();
          if (!createRes.ok) {
            return res.status(createRes.status).json({ error: createData.message ?? "Create error" });
          }
          blockPageId = createData.id;
        }
      }

      // ── Upsert Daily Log untuk slideDate (jika DAILY_DB_ID ada) ──────────
      if (DAILY_DB_ID && slideDate) {
        const slideCount = slides[slideDate] ?? 0;

        // Cek apakah sudah ada entry untuk tanggal ini
        const existRes = await fetch(
          `https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`,
          {
            method:  "POST",
            headers: notionHeaders(),
            body:    JSON.stringify({
              filter: {
                and: [
                  { property: "Weekly Tracker", relation: { contains: blockPageId } },
                  { property: "Date",           date:     { equals: slideDate }     },
                ],
              },
              page_size: 1,
            }),
          }
        );

        let dailyPageId = null;
        if (existRes.ok) {
          const existData = await existRes.json();
          dailyPageId = existData.results?.[0]?.id ?? null;
        }

        const dailyProps = {
          "Total Slide":    makeNumber(slideCount),
          Date:             makeDate(slideDate),
          "Weekly Tracker": makeRelation(blockPageId),
        };

        if (dailyPageId) {
          await fetch(`https://api.notion.com/v1/pages/${dailyPageId}`, {
            method:  "PATCH",
            headers: notionHeaders(),
            body:    JSON.stringify({ properties: dailyProps }),
          });
        } else {
          const dayLabel = new Date(slideDate + "T12:00:00").toLocaleDateString("id-ID", {
            weekday: "long", day: "numeric", month: "long",
          });
          await fetch("https://api.notion.com/v1/pages", {
            method:  "POST",
            headers: notionHeaders(),
            body:    JSON.stringify({
              parent:     { database_id: DAILY_DB_ID },
              properties: {
                ...dailyProps,
                Name: makeTitle(`${dayLabel} — ${username}`),
              },
            }),
          });
        }
      }

      return res.json({ success: true, pageId: blockPageId });

    } catch (err) {
      return res.status(500).json({ error: "Gagal menyimpan ke Notion: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
