const NOTION_TOKEN    = process.env.NOTION_TOKEN;
const WEEKLY_DB_ID    = process.env.NOTION_WEEKLY_DB_ID;   // rename jadi Block Tracker di Notion
const DAILY_DB_ID     = process.env.NOTION_DAILY_DB_ID;
const NOTION_VERSION  = "2022-06-28";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function getNumber(props, key) {
  return props[key]?.number ?? 0;
}

function makeTitle(text) { return { title: [{ text: { content: text } }] }; }
function makeNumber(n)    { return { number: n }; }
function makeDate(iso)    { return { date: { start: iso } }; }
function makeDateRange(start, end) { return { date: { start, end } }; }
function makeRelation(pageId)      { return { relation: [{ id: pageId }] }; }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !WEEKLY_DB_ID) {
    const missing = [];
    if (!NOTION_TOKEN)   missing.push("NOTION_TOKEN");
    if (!WEEKLY_DB_ID)   missing.push("NOTION_WEEKLY_DB_ID");
    return res.status(500).json({
      error: `Environment variable tidak ditemukan: ${missing.join(", ")}. Tambahkan di Vercel → Settings → Environment Variables, lalu Redeploy.`,
    });
  }

  /* ────────────────────────────────────────
     GET  /api/notion?start=YYYY-MM-DD&end=YYYY-MM-DD
     Ambil data blok berdasarkan rentang tanggal
  ──────────────────────────────────────── */
  if (req.method === "GET") {
    const blockStart = req.query.start;
    const blockEnd   = req.query.end;

    if (!blockStart || !blockEnd) {
      return res.json({
        found: false,
        pageId: null,
        data: { slides: {}, target: 30, nilaiUjian: 0 },
      });
    }

    try {
      /* 1. Cari halaman blok di Block Tracker */
      const blockRes = await fetch(
        `https://api.notion.com/v1/databases/${WEEKLY_DB_ID}/query`,
        {
          method: "POST",
          headers: notionHeaders(),
          body: JSON.stringify({
            filter: {
              and: [
                { property: "Range Date", date: { on_or_after:  blockStart } },
                { property: "Range Date", date: { on_or_before: blockEnd   } },
              ],
            },
            page_size: 1,
          }),
        }
      );
      const blockData = await blockRes.json();

      if (!blockRes.ok) {
        return res.status(blockRes.status).json({ error: blockData.message ?? "Notion API error" });
      }

      let blockPage   = blockData.results?.[0] ?? null;
      let slides      = {};   // { "YYYY-MM-DD": count }
      let target      = 30;
      let nilaiUjian  = 0;

      if (blockPage) {
        const p = blockPage.properties;
        target     = getNumber(p, "Weekly Target") || 30;
        nilaiUjian = getNumber(p, "Nilai Ujian");
      }

      /* 2. Ambil Daily Log untuk blok ini */
      if (DAILY_DB_ID) {
        const filter = blockPage
          ? { property: "Weekly Tracker", relation: { contains: blockPage.id } }
          : {
              and: [
                { property: "Date", date: { on_or_after:  blockStart } },
                { property: "Date", date: { on_or_before: blockEnd   } },
              ],
            };

        const dailyRes = await fetch(
          `https://api.notion.com/v1/databases/${DAILY_DB_ID}/query`,
          {
            method: "POST",
            headers: notionHeaders(),
            body: JSON.stringify({ filter, page_size: 100 }),
          }
        );

        if (dailyRes.ok) {
          const dailyData = await dailyRes.json();
          for (const page of dailyData.results ?? []) {
            const dp      = page.properties;
            const dateStr = dp["Date"]?.date?.start ?? "";
            const count   = getNumber(dp, "Total Slide");
            if (dateStr && count > 0) slides[dateStr] = count;
          }
        }
      }

      return res.json({
        found:  !!blockPage,
        pageId: blockPage?.id ?? null,
        data:   { slides, target, nilaiUjian },
      });

    } catch (err) {
      return res.status(500).json({ error: "Gagal mengambil data dari Notion: " + err.message });
    }
  }

  /* ────────────────────────────────────────
     POST /api/notion
     Simpan/update data blok dan daily log
  ──────────────────────────────────────── */
  if (req.method === "POST") {
    const {
      slides      = {},
      target      = 30,
      nilaiUjian  = 0,
      blockStart,
      blockEnd,
      pageId,
      slideDate,      // ISO date string hari yang diinput, atau undefined
    } = req.body;

    if (!blockStart || !blockEnd) {
      return res.status(400).json({ error: "blockStart dan blockEnd wajib diisi." });
    }

    try {
      /* 1. Upsert halaman blok di Block Tracker */
      const blockProps = {
        "Weekly Target": makeNumber(target),
        "Nilai Ujian":   makeNumber(nilaiUjian),
      };

      let blockResponse;
      if (pageId) {
        blockResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method:  "PATCH",
          headers: notionHeaders(),
          body:    JSON.stringify({ properties: blockProps }),
        });
      } else {
        blockResponse = await fetch("https://api.notion.com/v1/pages", {
          method:  "POST",
          headers: notionHeaders(),
          body:    JSON.stringify({
            parent:     { database_id: WEEKLY_DB_ID },
            properties: {
              ...blockProps,
              Name:         makeTitle(`Blok ${blockStart} – ${blockEnd}`),
              "Range Date": makeDateRange(blockStart, blockEnd),
            },
          }),
        });
      }

      const blockResult = await blockResponse.json();
      if (!blockResponse.ok) {
        return res.status(blockResponse.status).json({
          error: blockResult.message ?? "Notion API error (block tracker)",
        });
      }
      const blockPageId = blockResult.id;

      /* 2. Upsert Daily Log untuk tanggal yang diinput hari ini */
      if (DAILY_DB_ID && slideDate) {
        const slideCount = slides[slideDate] ?? 0;

        /* Cek apakah entry tanggal ini sudah ada */
        const existingRes = await fetch(
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
        if (existingRes.ok) {
          const existingData = await existingRes.json();
          dailyPageId = existingData.results?.[0]?.id ?? null;
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
          const dayLabel = new Date(slideDate + "T12:00:00")
            .toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });
          await fetch("https://api.notion.com/v1/pages", {
            method:  "POST",
            headers: notionHeaders(),
            body:    JSON.stringify({
              parent:     { database_id: DAILY_DB_ID },
              properties: {
                ...dailyProps,
                Name: makeTitle(`${dayLabel}, ${slideDate}`),
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
