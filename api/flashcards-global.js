// /api/flashcards-global.js  —  v2 (chunked)
//
// Endpoint untuk menyimpan flashcard GLOBAL per username,
// tidak terikat ke blok manapun. Kartu tetap ada di semua
// device dan semua blok belajar.
//
// Kolom WAJIB di Notion Flashcard Global DB:
//   Name           → title
//   Username       → rich_text        ← kunci unik per user
//   Flashcards     → rich_text        chunk 1 dari JSON array
//   Flashcards2    → rich_text        chunk 2
//   Flashcards3    → rich_text        chunk 3
//   Flashcards4    → rich_text        chunk 4
//   Flashcards5    → rich_text        chunk 5
//   DifficultCards  → rich_text       chunk 1 dari JSON array ID
//   DifficultCards2 → rich_text       chunk 2
//   Saved At       → number           Unix timestamp ms
//
// Kapasitas perkiraan (5 kolom FC × 1990 char):
//   Q+A ~50 char  → ±500 kartu
//   Q+A ~150 char → ±150 kartu
//   Q+A ~400 char → ±60  kartu
//
// ENV yang dibutuhkan:
//   NOTION_TOKEN
//   NOTION_FLASHCARD_GLOBAL_DB_ID

const NOTION_TOKEN           = process.env.NOTION_TOKEN;
const FLASHCARD_GLOBAL_DB_ID = process.env.NOTION_FLASHCARD_GLOBAL_DB_ID;
const NOTION_VERSION         = "2022-06-28";

// ── Kolom chunk ────────────────────────────────────────────────────────────────
const FC_COLS = ["Flashcards", "Flashcards2", "Flashcards3", "Flashcards4", "Flashcards5"];
const DC_COLS = ["DifficultCards", "DifficultCards2"];
const CHUNK_SIZE = 1990; // margin aman di bawah limit 2000 Notion

// ── Helpers Notion ─────────────────────────────────────────────────────────────
function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function makeTitle(t)      { return { title:     [{ text: { content: String(t).slice(0, 2000) } }] }; }
function makeRichText(t)   { return { rich_text: [{ text: { content: String(t ?? "").slice(0, 1999) } }] }; }
function getText(props, k)  { return props[k]?.rich_text?.[0]?.plain_text ?? ""; }

// ── Chunking ───────────────────────────────────────────────────────────────────

/**
 * Pecah string panjang ke array potongan maks CHUNK_SIZE karakter.
 */
function chunkString(str, size = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks.length ? chunks : [""];
}

/**
 * Serialisasi array JS → props Notion multi-kolom.
 * Kolom yang tidak terpakai diisi string kosong (agar Notion menghapus sisa data lama).
 */
function encodeChunks(arr, cols) {
  let full;
  try { full = JSON.stringify(arr ?? []); } catch { full = "[]"; }

  const chunks = chunkString(full);
  const props  = {};
  cols.forEach((col, i) => {
    props[col] = makeRichText(chunks[i] ?? "");
  });
  return props;
}

/**
 * Baca props Notion multi-kolom → gabungkan → parse JSON → array JS.
 */
function decodeChunks(props, cols) {
  const joined = cols.map(col => getText(props, col)).join("");
  if (!joined) return [];
  try { return JSON.parse(joined); } catch { return []; }
}

// ── Cari page existing berdasarkan username ────────────────────────────────────
async function findGlobalPage(username) {
  const r = await fetch(
    `https://api.notion.com/v1/databases/${FLASHCARD_GLOBAL_DB_ID}/query`,
    {
      method:  "POST",
      headers: notionHeaders(),
      body:    JSON.stringify({
        filter:    { property: "Username", rich_text: { equals: username } },
        page_size: 1,
      }),
    }
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d.results?.[0] ?? null;
}

// ── Handler ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN || !FLASHCARD_GLOBAL_DB_ID) {
    return res.status(500).json({
      error: "NOTION_TOKEN atau NOTION_FLASHCARD_GLOBAL_DB_ID belum diset.",
    });
  }

  // ── GET: ambil flashcard global milik username ───────────────────────────────
  if (req.method === "GET") {
    const username = (req.query.username ?? "").trim();
    if (!username)
      return res.status(400).json({ error: "Parameter ?username= wajib diisi." });

    try {
      const page = await findGlobalPage(username);
      if (!page)
        return res.json({ found: false, flashcards: [], difficultCards: [] });

      const p            = page.properties;
      const flashcards    = decodeChunks(p, FC_COLS);
      const difficultCards = decodeChunks(p, DC_COLS);

      return res.json({ found: true, flashcards, difficultCards });

    } catch (err) {
      console.error("[flashcards-global GET]", err.message);
      return res.status(500).json({ error: "Gagal mengambil data: " + err.message });
    }
  }

  // ── POST: simpan/update flashcard global milik username ─────────────────────
  if (req.method === "POST") {
    const username       = String(req.body?.username      ?? "").trim();
    const flashcards     = req.body?.flashcards            ?? [];
    const difficultCards  = req.body?.difficultCards       ?? [];
    const savedAt        = req.body?.savedAt               ?? Date.now();

    if (!username)
      return res.status(400).json({ error: "Field 'username' wajib diisi." });

    try {
      const props = {
        "Username": makeRichText(username),
        "Saved At": { number: typeof savedAt === "number" ? savedAt : Date.now() },
        ...encodeChunks(flashcards,    FC_COLS),
        ...encodeChunks(difficultCards, DC_COLS),
      };

      const existing = await findGlobalPage(username);

      if (existing) {
        // ── UPDATE baris yang sudah ada ────────────────────────────────────────
        const r = await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
          method:  "PATCH",
          headers: notionHeaders(),
          body:    JSON.stringify({ properties: props }),
        });
        const d = await r.json();
        if (!r.ok) {
          console.error("[flashcards-global PATCH]", d.message);
          return res.status(r.status).json({ error: d.message ?? "Notion PATCH error" });
        }
        return res.json({ success: true, pageId: existing.id });

      } else {
        // ── BUAT baris baru untuk user ini ─────────────────────────────────────
        const r = await fetch("https://api.notion.com/v1/pages", {
          method:  "POST",
          headers: notionHeaders(),
          body:    JSON.stringify({
            parent:     { database_id: FLASHCARD_GLOBAL_DB_ID },
            properties: { Name: makeTitle(username), ...props },
          }),
        });
        const d = await r.json();
        if (!r.ok) {
          console.error("[flashcards-global POST]", d.message);
          return res.status(r.status).json({ error: d.message ?? "Notion POST error" });
        }
        return res.json({ success: true, pageId: d.id });
      }

    } catch (err) {
      console.error("[flashcards-global POST]", err.message);
      return res.status(500).json({ error: "Gagal menyimpan: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
