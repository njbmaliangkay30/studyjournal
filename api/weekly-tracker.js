// ============================================================
// GANTI SELURUH BLOK SYNC & ACTIONS DI HTML DENGAN INI
// (dari komentar "NOTION (MOCK)" sampai akhir script)
// ============================================================

      /* ---------- FLAG GLOBAL ---------- */
      let isSaving = false; // Mencegah auto-sync menimpa data saat sedang menyimpan

      /* ---------- SYNC ---------- */
      function setSyncStatus(status, msg) {
        const bar = document.getElementById("sync-bar");
        if (bar) bar.className = "sync-bar " + status;
        const syncTxt = document.getElementById("sync-txt");
        if (syncTxt) syncTxt.textContent = msg;
      }
      function showError(msg) {
        const box = document.getElementById("error-box");
        if (!box) return;
        if (msg) { box.textContent = msg; box.style.display = "block"; }
        else box.style.display = "none";
      }

      // Ambil semua data user dari Notion berdasarkan username
      async function loadUserFromNotion(username, blockName) {
        if (!username) return;
        // PERBAIKAN BUG 2: Jangan sync jika sedang ada operasi simpan
        if (isSaving) return;

        setSyncStatus("syncing", "Menarik data dari Hutan Sihir...");

        try {
          // PERBAIKAN BUG 3: Selalu baca blockName terbaru dari localStorage
          const effectiveBlock = blockName || ls('rv_blockName', '') || '';
          const url = `/api/weekly-tracker?username=${encodeURIComponent(username)}`
                    + (effectiveBlock ? `&blockName=${encodeURIComponent(effectiveBlock)}` : '');

          const res = await fetch(url);

          // PERBAIKAN BUG 4: Tangani response error dengan informatif
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            const msg = errData.error || `HTTP ${res.status}`;
            setSyncStatus("error", t('txt_sync_err'));
            showError(`Gagal memuat data: ${msg}`);
            console.error("[loadUserFromNotion] Error:", msg);
            return;
          }

          const ed = await res.json();

          if (ed.found) {
            // Sinkron data dari Notion ke state
            state.target     = ed.target     || state.target;
            state.blockStart = ed.blockStart  || state.blockStart;
            state.blockEnd   = ed.blockEnd    || state.blockEnd;
            state.blokPageId = ed.pageId;

            // PERBAIKAN BUG 2: Hanya timpa pptDots & slides jika tidak sedang menyimpan
            if (!isSaving) {
              state.pptDots = Array.isArray(ed.pptDots) ? ed.pptDots
                            : (() => { try { return JSON.parse(ed.pptDots || "[]"); } catch { return []; } })();
              state.slides  = ed.slides || {};
            }

            // Simpan ke localStorage
            ss('rv_target',      state.target);
            ss('rv_block_start', state.blockStart);
            ss('rv_block_end',   state.blockEnd);
            ss('rv_blokPageId',  state.blokPageId);
            ss('rv_pptDots',     state.pptDots);
            ss('rv_slides',      state.slides);

            setSyncStatus("ok", t('txt_sync_ok'));
            showError(null);
            render();
            if (typeof renderPptTrack === "function") renderPptTrack();
          } else {
            setSyncStatus("ok", t('txt_ready'));
            checkSetupModal();
          }
        } catch (err) {
          setSyncStatus("error", t('txt_sync_err'));
          showError(t('txt_sync_err_desc'));
          console.error("[loadUserFromNotion] Network error:", err.message);
        }
      }

      // Auto-load saat startup
      async function loadFromNotion() {
        // PERBAIKAN BUG 3: Baca blockName dari localStorage, bukan hanya state
        const syncCode  = state.syncCode  || ls('rv_syncCode',  '');
        const blockName = state.blockName || ls('rv_blockName', '');

        if (syncCode) {
          await loadUserFromNotion(syncCode, blockName || null);
        } else {
          setSyncStatus("ok", t('txt_ready'));
        }
        render();
      }

      // Simpan semua progress ke Notion
      async function saveToNotion(dateStr) {
        const targetDate = dateStr || fmtISO(new Date());

        // PERBAIKAN BUG 1: Selalu baca nilai terbaru dari localStorage sebagai fallback
        const username   = state.syncCode  || ls('rv_syncCode',  '');
        const blockName  = state.blockName || ls('rv_blockName', '');
        const blockStart = state.blockStart || ls('rv_block_start', '');
        const blockEnd   = state.blockEnd   || ls('rv_block_end',   '');

        // Guard: jangan POST kalau field wajib kosong
        if (!username || !blockStart || !blockEnd) {
          console.warn("[saveToNotion] Skip — field kosong:", { username, blockStart, blockEnd });
          setSyncStatus("ok", "✦ Tersimpan lokal");
          return false;
        }

        // Set flag agar auto-sync tidak menimpa data yang sedang disimpan
        isSaving = true;
        setSyncStatus("syncing", t('txt_saving'));

        try {
          const res = await fetch("/api/weekly-tracker", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username,
              blockName:  blockName  || "",
              target:     state.target     || 30,
              blockStart,
              blockEnd,
              pptDots:    state.pptDots    || [],
              moods:      state.moods      || {},
              nilaiUjian: state.nilaiUjian || 0,
              pageId:     state.blokPageId || null,
              slideDate:  targetDate,
              slides:     state.slides     || {}
            })
          });

          // PERBAIKAN BUG 4: Tangani error 400 dengan pesan yang jelas
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            const msg = errData.error || `HTTP ${res.status}`;
            // Tampilkan apa yang diterima server untuk debug
            if (errData.received) {
              console.error("[saveToNotion] 400 detail:", errData.received);
            }
            setSyncStatus("error", t('txt_sync_err'));
            showError(`Gagal simpan: ${msg}`);
            return false;
          }

          const json = await res.json();
          if (json.pageId) {
            state.blokPageId = json.pageId;
            ss("rv_blokPageId", state.blokPageId);
          }
          setSyncStatus("ok", t('txt_sync_ok'));
          showError(null);
          return true;

        } catch (err) {
          setSyncStatus("error", t('txt_sync_err'));
          showError(t('txt_sync_err_desc'));
          console.error("[saveToNotion] Network error:", err.message);
          return false;
        } finally {
          // PENTING: Selalu lepas flag setelah selesai
          isSaving = false;
        }
      }

      /* ---------- INISIALISASI (ganti bagian bawah script) ---------- */
      createSparkles();
      applyTheme();
      applyLanguage();
      if (state.syncCode) loadFromNotion();
      checkWelcomeModal();
      setupReminders();
      render();
      requestAnimationFrame(updateIndicator);
      window.addEventListener('resize', updateIndicator);

      // Auto-sync saat tab aktif kembali
      document.addEventListener("visibilitychange", () => {
        // PERBAIKAN BUG 2: Tidak sync jika sedang menyimpan
        if (document.visibilityState === "visible" && state.syncCode && !isSaving) {
          const blockName = state.blockName || ls('rv_blockName', '');
          loadUserFromNotion(state.syncCode, blockName || null);
        }
      });

      // Auto-sync polling setiap 60 detik (diperlambat dari 30s untuk mengurangi konflik)
      setInterval(() => {
        // PERBAIKAN BUG 2: Tidak sync jika tab tersembunyi atau sedang menyimpan
        if (state.syncCode && !document.hidden && !isSaving) {
          const blockName = state.blockName || ls('rv_blockName', '');
          loadUserFromNotion(state.syncCode, blockName || null);
        }
      }, 60000);
