const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_WEEKLY_ID = process.env.NOTION_DATABASE_ID;
const NOTION_DAILY_ID = process.env.NOTION_DAILY_LOG_ID;
const NOTION_VERSION = "2022-06-28";

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

function getWeekBounds() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    monday: monday.toISOString().split("T")[0],
    sunday: sunday.toISOString().split("T")[0],
  };
}

function getNumber(props, key) {
  return props[key]?.number ?? 0;
}

function makeTitle(text) {
  return { title: [{ text: { content: text } }] };
}
function makeNumber(n) {
  return { number: n };
}
function makeDate(iso) {
  return { date: { start: iso } };
}
function makeDateRange(start, end) {
  return { date: { start, end } };
}
function makeRelation(pageId) {
  return { relation: [{ id: pageId }] };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!NOTION_TOKEN || !NOTION_WEEKLY_ID) {
    return res.status(500).json({ error: "Notion credentials not configured. Tambahkan NOTION_TOKEN dan NOTION_DATABASE_ID di Vercel environment variables." });
  }

  /* ── GET: fetch current week data ── */
  if (req.method === "GET") {
    const { monday, sunday } = getWeekBounds();

    try {
      const weeklyRes = await fetch(
        `https://api.notion.com/v1/databases/${NOTION_WEEKLY_ID}/query`,
        {
          method: "POST",
          headers: notionHeaders(),
          body: JSON.stringify({
            filter: {
              and: [
                { property: "Range Date", date: { on_or_after: monday } },
                { property: "Range Date", date: { on_or_before: sunday } },
              ],
            },
            page_size: 1,
          }),
        }
      );
      const weeklyData = await weeklyRes.json();

      if (!weeklyRes.ok) {
        return res.status(weeklyRes.status).json({ error: weeklyData.message ?? "Notion API error" });
      }

      let weeklyPage = weeklyData.results?.[0] ?? null;
      let slides = [0, 0, 0, 0, 0, 0, 0];
      let target = 30;
      let nilaiUjian = 0;
      let name = "Revalina";

      if (weeklyPage) {
        const p = weeklyPage.properties;
        target = getNumber(p, "Weekly Target") || 30;
        nilaiUjian = getNumber(p, "Nilai Ujian");
        const titleArr = p["Name"]?.title ?? [];
        name = titleArr[0]?.plain_text ?? "Revalina";
      }

      if (NOTION_DAILY_ID && weeklyPage) {
        const dailyRes = await fetch(
          `https://api.notion.com/v1/databases/${NOTION_DAILY_ID}/query`,
          {
            method: "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              filter: {
                property: "Weekly Tracker",
                relation: { contains: weeklyPage.id },
              },
              page_size: 7,
            }),
          }
        );

        if (dailyRes.ok) {
          const dailyData = await dailyRes.json();
          for (const page of dailyData.results ?? []) {
            const dp = page.properties;
            const dateStr = dp["Date"]?.date?.start ?? "";
            if (dateStr) {
              const dow = new Date(dateStr + "T12:00:00").getDay();
              const idx = dow === 0 ? 6 : dow - 1;
              const s = getNumber(dp, "Total Slide");
              if (s > 0) slides[idx] = s;
            }
          }
        }
      } else if (NOTION_DAILY_ID && !weeklyPage) {
        const dailyRes = await fetch(
          `https://api.notion.com/v1/databases/${NOTION_DAILY_ID}/query`,
          {
            method: "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              filter: {
                and: [
                  { property: "Date", date: { on_or_after: monday } },
                  { property: "Date", date: { on_or_before: sunday } },
                ],
              },
              page_size: 7,
            }),
          }
        );
        if (dailyRes.ok) {
          const dailyData = await dailyRes.json();
          for (const page of dailyData.results ?? []) {
            const dp = page.properties;
            const dateStr = dp["Date"]?.date?.start ?? "";
            if (dateStr) {
              const dow = new Date(dateStr + "T12:00:00").getDay();
              const idx = dow === 0 ? 6 : dow - 1;
              const s = getNumber(dp, "Total Slide");
              if (s > 0) slides[idx] = s;
            }
          }
        }
      }

      return res.json({
        found: !!weeklyPage,
        pageId: weeklyPage?.id ?? null,
        weekBounds: { monday, sunday },
        data: { slides, target, nilaiUjian, name },
      });
    } catch (err) {
      return res.status(500).json({ error: "Gagal mengambil data dari Notion: " + err.message });
    }
  }

  /* ── POST: save data ── */
  if (req.method === "POST") {
    const { slides, target, nilaiUjian, name, pageId, dayIndex } = req.body;
    const { monday, sunday } = getWeekBounds();
    const today = todayISO();

    try {
      const weeklyProps = {
        "Weekly Target": makeNumber(target ?? 30),
        "Nilai Ujian": makeNumber(nilaiUjian ?? 0),
      };

      let weeklyResponse;
      if (pageId) {
        weeklyResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: "PATCH",
          headers: notionHeaders(),
          body: JSON.stringify({ properties: weeklyProps }),
        });
      } else {
        weeklyResponse = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionHeaders(),
          body: JSON.stringify({
            parent: { database_id: NOTION_WEEKLY_ID },
            properties: {
              ...weeklyProps,
              "Name": makeTitle(`Week ${monday} – ${sunday}`),
              "Range Date": makeDateRange(monday, sunday),
            },
          }),
        });
      }

      const weeklyResult = await weeklyResponse.json();
      if (!weeklyResponse.ok) {
        return res.status(weeklyResponse.status).json({
          error: weeklyResult.message ?? "Notion API error (weekly)",
        });
      }
      const weeklyPageId = weeklyResult.id;

      if (NOTION_DAILY_ID && typeof dayIndex === "number") {
        const dayNames = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
        const dayName = dayNames[dayIndex] ?? "Senin";
        const slideCount = (slides ?? [])[dayIndex] ?? 0;

        const existingRes = await fetch(
          `https://api.notion.com/v1/databases/${NOTION_DAILY_ID}/query`,
          {
            method: "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              filter: {
                and: [
                  { property: "Weekly Tracker", relation: { contains: weeklyPageId } },
                  { property: "Date", date: { equals: today } },
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
          "Total Slide": makeNumber(slideCount),
          "Date": makeDate(today),
          "Weekly Tracker": makeRelation(weeklyPageId),
        };

        if (dailyPageId) {
          await fetch(`https://api.notion.com/v1/pages/${dailyPageId}`, {
            method: "PATCH",
            headers: notionHeaders(),
            body: JSON.stringify({ properties: dailyProps }),
          });
        } else {
          await fetch("https://api.notion.com/v1/pages", {
            method: "POST",
            headers: notionHeaders(),
            body: JSON.stringify({
              parent: { database_id: NOTION_DAILY_ID },
              properties: {
                ...dailyProps,
                "Name": makeTitle(`${dayName}, ${today}`),
              },
            }),
          });
        }
      }

      return res.json({ success: true, pageId: weeklyPageId });
    } catch (err) {
      return res.status(500).json({ error: "Gagal menyimpan ke Notion: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
