// ==UserScript==
// @name         Amazon A+ Scraper
// @namespace    http://tampermonkey.net/
// @version      3.4
// @match        https://www.amazon.com/
// @match        https://www.amazon.com/dp/*
// @match        https://www.amazon.com/*/dp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @connect      localhost
// ==/UserScript==

(async () => {
    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ════════════════════════════════════════════════════════════
    // CONTROL PANEL — shown only on https://www.amazon.com/
    // ════════════════════════════════════════════════════════════
    if (location.pathname === "/") {
        const CONCURRENCY = 5;
        // Server-side session is the source of truth — no GM race conditions
        let cachedDone = 0;
        let cachedEntries = [];
        const panel = document.createElement("div");
        panel.style.cssText = `
            position:fixed;bottom:24px;right:24px;z-index:99999;
            background:#232f3e;color:#fff;border-radius:10px;
            padding:16px 18px;width:360px;font-family:sans-serif;
            box-shadow:0 4px 20px rgba(0,0,0,.5);font-size:14px;
        `;
        document.body.appendChild(panel);

        const levelColor = {
            "A+ Premium": "#e65c00",
            "A+ Standard": "#1976d2",
            None: "#777",
        };

        function extractAsin(url) {
            const m = url.match(/\/dp\/([A-Z0-9]{10})/);
            return m ? m[1] : null;
        }

        // Check DB for which ASINs are missing, call back with (missingUrls, foundCount)
        function checkMissing(allUrls, cb) {
            const asins = allUrls.map(extractAsin).filter(Boolean);
            const asinToUrl = {};
            allUrls.forEach((u) => {
                const a = extractAsin(u);
                if (a) asinToUrl[a] = u;
            });
            GM_xmlhttpRequest({
                method: "POST",
                url: "http://localhost:3003/api/check-asins",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ asins }),
                onload: (r) => {
                    try {
                        const d = JSON.parse(r.responseText);
                        const missingUrls = (d.missing || asins)
                            .map((a) => asinToUrl[a])
                            .filter(Boolean);
                        cb(missingUrls, d.found || 0);
                    } catch (e) {
                        cb(allUrls, 0);
                    }
                },
                onerror: () => cb(allUrls, 0),
            });
        }

        // Create a server session and kick off scraping for missingUrls
        function startSession(missingUrls, alreadyDone) {
            GM_xmlhttpRequest({
                method: "POST",
                url: "http://localhost:3003/api/session",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({}),
                onload: (r) => {
                    let sessionId = "";
                    try {
                        sessionId = JSON.parse(r.responseText).sessionId || "";
                    } catch (e) {}
                    cachedDone = alreadyDone;
                    cachedEntries = [];
                    const effectiveTotal = missingUrls.length + alreadyDone;
                    GM_setValue("queue", [...missingUrls]);
                    GM_setValue("total", effectiveTotal);
                    GM_setValue("_baselineDone", alreadyDone);
                    GM_setValue("sessionId", sessionId);
                    GM_setValue("paused", false);
                    document.getElementById("ap-input").style.display = "none";
                    document.getElementById("ap-progress").style.display =
                        "block";
                    openNextTabs();
                    updateDynamicParts(
                        effectiveTotal,
                        alreadyDone,
                        [...missingUrls],
                        0,
                        true,
                        false,
                        false,
                        "",
                    );
                },
                onerror: () =>
                    alert(
                        "Cannot reach the server. Is node server.js running?",
                    ),
            });
        }

        function openNextTabs() {
            const total = GM_getValue("total", 0);
            const paused = GM_getValue("paused", false);
            const queue = [...GM_getValue("queue", [])];
            if (total === 0 || paused || cachedDone >= total) return;
            // openedSoFar = how many tabs we have dequeued and opened
            const openedSoFar = total - queue.length;
            const active = openedSoFar - cachedDone;
            let slots = CONCURRENCY - active;
            if (slots <= 0 || queue.length === 0) return;
            while (slots > 0 && queue.length > 0) {
                GM_openInTab(queue.shift(), { active: false, insert: true });
                slots--;
            }
            GM_setValue("queue", queue);
        }

        // Only update parts of the panel that change — never touch the textarea
        function updateDynamicParts(
            total,
            doneCount,
            queue,
            active,
            running,
            done,
            paused,
            logRows,
        ) {
            // status badge
            const badge = document.getElementById("ap-badge");
            if (badge) {
                badge.style.background = paused
                    ? "#555"
                    : running
                      ? "#f90"
                      : done
                        ? "#2e7d32"
                        : "#555";
                badge.textContent = paused
                    ? `Paused ${doneCount} / ${total}`
                    : running
                      ? `${doneCount} / ${total} · ${active} active`
                      : done
                        ? "✅ Done"
                        : "Idle";
            }
            // progress bar
            const bar = document.getElementById("ap-bar-fill");
            if (bar)
                bar.style.width = total
                    ? `${Math.round((doneCount / total) * 100)}%`
                    : "0%";
            // queue info
            const info = document.getElementById("ap-info");
            if (info)
                info.textContent = `${queue.length} queued · ${active} scraping · ${doneCount} done`;
            // log rows
            const logEl = document.getElementById("ap-log");
            if (logEl) logEl.innerHTML = logRows;
            const logLabel = document.getElementById("ap-log-label");
            if (logLabel)
                logLabel.textContent = `${running || paused ? "Live results" : "Last run"} — ${doneCount} of ${total} saved`;
        }

        function renderPanel() {
            const total = GM_getValue("total", 0);
            const queue = GM_getValue("queue", []);
            const urls = GM_getValue("urls", []);
            const forceRefresh = GM_getValue("forceRefresh", false);
            const paused = GM_getValue("paused", false);
            const openedSoFar = total - queue.length;
            const active = Math.max(0, openedSoFar - cachedDone);
            const running = total > 0 && cachedDone < total;
            const done = total > 0 && cachedDone >= total;
            const active_or_paused = running || paused;

            const logRows = cachedEntries
                .slice()
                .reverse()
                .map(
                    (e) =>
                        `<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid #2e3f50">
                    <span style="font-size:11px;font-weight:bold;color:${e.ok ? "#81c784" : "#e57373"};white-space:nowrap">${e.ok ? "✓ OK" : "✗ " + (e.status || "ERR")}</span>
                    <code style="font-size:11px;color:#aaa">${e.asin}</code>
                    <span style="flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.product_name || "—"}</span>
                    <span style="font-size:10px;background:${levelColor[e.aplus_level] || "#555"};color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap">${e.aplus_level || "?"}</span>
                </div>`,
                )
                .join("");

            // If panel is already built, just patch the dynamic parts
            if (document.getElementById("ap-badge")) {
                updateDynamicParts(
                    total,
                    cachedDone,
                    queue,
                    active,
                    running,
                    done,
                    paused,
                    logRows,
                );
                return;
            }

            // First render — build full HTML
            panel.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <span style="display:flex;align-items:center;gap:6px">
                        <strong style="font-size:15px">📦 A+ Scraper</strong>
                        <span id="ap-server-dot" title="Checking server…" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#888"></span>
                    </span>
                    <span id="ap-badge" style="font-size:12px;padding:2px 8px;border-radius:4px"></span>
                </div>

                <!-- idle / done: textarea input -->
                <div id="ap-input" style="display:${active_or_paused ? "none" : "block"}">
                    <textarea id="aplus-urls" placeholder="Paste URLs here — one per line" style="
                        width:100%;height:110px;background:#1a2433;border:1px solid #444;
                        color:#fff;border-radius:6px;padding:8px;font-size:12px;
                        resize:vertical;box-sizing:border-box;margin-bottom:8px
                    ">${done ? urls.join("\n") : ""}</textarea>
                    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;margin-bottom:8px">
                        <input id="ap-force-refresh" type="checkbox" style="width:14px;height:14px;" ${forceRefresh ? "checked" : ""}>
                        Force refresh existing products even if already in DB
                    </label>
                    <button id="aplus-start" style="width:100%;padding:8px;background:#f90;border:none;border-radius:6px;color:#111;cursor:pointer;font-weight:bold;font-size:14px">
                        ▶ Start Scraping
                    </button>
                    <div id="ap-done-msg" style="margin-top:8px;color:#81c784;font-size:12px;text-align:center;display:${done ? "block" : "none"}">✅ All ${total} products scraped</div>
                </div>

                <!-- running / paused: progress -->
                <div id="ap-progress" style="display:${active_or_paused ? "block" : "none"}">
                    <div style="background:#333;border-radius:4px;height:6px;margin-bottom:8px">
                        <div id="ap-bar-fill" style="background:#f90;height:6px;border-radius:4px;width:0%"></div>
                    </div>
                    <div id="ap-info" style="background:#1a2433;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:11px;color:#aaa"></div>
                    <div style="display:flex;gap:6px;margin-bottom:8px">
                        <button id="ap-btn-pause" style="flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;background:${paused ? "#f90" : "#555"};color:${paused ? "#111" : "#fff"}">
                            ${paused ? "▶ Resume" : "⏸ Pause"}
                        </button>
                        <button id="ap-btn-stop" style="flex:1;padding:7px;background:#c62828;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:bold;font-size:13px">
                            ⛔ Stop
                        </button>
                    </div>
                </div>

                <!-- log -->
                <div id="ap-log-wrap" style="display:${cachedEntries.length ? "block" : "none"}">
                    <div id="ap-log-label" style="font-size:11px;color:#888;margin-bottom:4px"></div>
                    <div id="ap-log" style="max-height:200px;overflow-y:auto"></div>
                </div>
            `;

            updateDynamicParts(
                total,
                cachedDone,
                queue,
                active,
                running,
                done,
                paused,
                logRows,
            );

            // Wire buttons — they stay in the DOM, so only need to be bound once
            document
                .getElementById("aplus-start")
                ?.addEventListener("click", () => {
                    const raw = document
                        .getElementById("aplus-urls")
                        .value.trim();
                    const list = raw
                        .split("\n")
                        .map((u) => u.trim())
                        .filter((u) => u.startsWith("http"));
                    if (!list.length) {
                        alert("No valid URLs found — paste one URL per line.");
                        return;
                    }
                    GM_setValue("urls", list);
                    const forceRefresh =
                        document.getElementById("ap-force-refresh")?.checked;
                    GM_setValue("forceRefresh", forceRefresh);
                    const startBtn = document.getElementById("aplus-start");
                    if (startBtn) {
                        startBtn.disabled = true;
                        startBtn.textContent = forceRefresh
                            ? "Refreshing…"
                            : "Checking…";
                    }
                    if (forceRefresh) {
                        if (startBtn) {
                            startBtn.disabled = false;
                            startBtn.textContent = "▶ Start Scraping";
                        }
                        startSession(list, 0);
                        return;
                    }
                    // Check DB first — skip already-done products (resume support)
                    checkMissing(list, (missingUrls, foundCount) => {
                        if (startBtn) {
                            startBtn.disabled = false;
                            startBtn.textContent = "▶ Start Scraping";
                        }
                        if (missingUrls.length === 0) {
                            alert(
                                `All ${list.length} products are already in the database!\nIf you want to re-scrape them, enable Force refresh and try again.`,
                            );
                            return;
                        }
                        if (foundCount > 0) {
                            const ok = confirm(
                                `${foundCount} of ${list.length} already scraped. Resume with the remaining ${missingUrls.length}?`,
                            );
                            if (!ok) return;
                        }
                        startSession(missingUrls, foundCount);
                    });
                });

            document
                .getElementById("ap-btn-pause")
                ?.addEventListener("click", () => {
                    const isPaused = GM_getValue("paused", false);
                    GM_setValue("paused", !isPaused);
                    const btn = document.getElementById("ap-btn-pause");
                    if (btn) {
                        btn.textContent = isPaused ? "⏸ Pause" : "▶ Resume";
                        btn.style.background = isPaused ? "#555" : "#f90";
                        btn.style.color = isPaused ? "#fff" : "#111";
                    }
                    if (isPaused) openNextTabs(); // resume: open queued tabs immediately
                });

            document
                .getElementById("ap-btn-stop")
                ?.addEventListener("click", () => {
                    GM_setValue("total", 0);
                    GM_setValue("queue", []);
                    GM_setValue("sessionId", "");
                    GM_setValue("paused", false);
                    cachedDone = 0;
                    cachedEntries = [];
                    // rebuild panel so textarea reappears
                    panel.innerHTML = "";
                    renderPanel();
                });
            document
                .getElementById("ap-force-refresh")
                ?.addEventListener("change", (event) => {
                    GM_setValue("forceRefresh", event.target.checked);
                });
        }

        // Server health check — pings /api/stats and shows a dot in the panel header
        function checkServer() {
            GM_xmlhttpRequest({
                method: "GET",
                url: "http://localhost:3003/api/stats",
                onload: () => {
                    const dot = document.getElementById("ap-server-dot");
                    if (dot) {
                        dot.style.background = "#81c784";
                        dot.title = "Server OK";
                    }
                },
                onerror: () => {
                    const dot = document.getElementById("ap-server-dot");
                    if (dot) {
                        dot.style.background = "#e57373";
                        dot.title =
                            "Server unreachable — is node server.js running?";
                    }
                },
            });
        }

        // Poll server session for accurate done count — auto-recovers if session lost
        let recovering = false;
        function pollSession() {
            const sessionId = GM_getValue("sessionId", "");
            if (!sessionId) return;
            GM_xmlhttpRequest({
                method: "GET",
                url: `http://localhost:3003/api/session/${sessionId}`,
                onload: (r) => {
                    if (r.status === 404 && !recovering) {
                        // Session lost (server restarted) — auto-recover using DB
                        recovering = true;
                        const allUrls = GM_getValue("urls", []);
                        if (!allUrls.length) {
                            recovering = false;
                            return;
                        }
                        const badge = document.getElementById("ap-badge");
                        if (badge) {
                            badge.textContent = "Recovering…";
                            badge.style.background = "#e65c00";
                        }
                        checkMissing(allUrls, (missingUrls, foundCount) => {
                            recovering = false;
                            if (missingUrls.length === 0) {
                                cachedDone = allUrls.length;
                                GM_setValue("total", allUrls.length);
                                GM_setValue("queue", []);
                                GM_setValue("sessionId", "");
                                refreshUI();
                                return;
                            }
                            startSession(missingUrls, foundCount);
                        });
                        return;
                    }
                    try {
                        const data = JSON.parse(r.responseText);
                        const baseline = GM_getValue("_baselineDone", 0);
                        cachedDone = (data.done || 0) + baseline;
                        cachedEntries = data.entries || [];
                    } catch (e) {}
                    openNextTabs();
                    refreshUI();
                },
                onerror: () => {
                    openNextTabs();
                    refreshUI();
                },
            });
        }

        function refreshUI() {
            const total = GM_getValue("total", 0);
            const queue = GM_getValue("queue", []);
            const paused = GM_getValue("paused", false);
            const openedSoFar = total - queue.length;
            const active = Math.max(0, openedSoFar - cachedDone);
            const running = total > 0 && cachedDone < total;
            const done = total > 0 && cachedDone >= total;
            const logRows = cachedEntries
                .slice()
                .reverse()
                .map(
                    (e) =>
                        `<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid #2e3f50">
                    <span style="font-size:11px;font-weight:bold;color:${e.ok ? "#81c784" : "#e57373"};white-space:nowrap">${e.ok ? "✓ OK" : "✗ " + (e.status || "ERR")}</span>
                    <code style="font-size:11px;color:#aaa">${e.asin}</code>
                    <span style="flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.product_name || "—"}</span>
                    <span style="font-size:10px;background:${e.aplus_level === "A+ Premium" ? "#e65c00" : e.aplus_level === "A+ Standard" ? "#1976d2" : "#777"};color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap">${e.aplus_level || "?"}</span>
                </div>`,
                )
                .join("");
            if (document.getElementById("ap-badge")) {
                updateDynamicParts(
                    total,
                    cachedDone,
                    queue,
                    active,
                    running,
                    done,
                    paused,
                    logRows,
                );
            }
            const logWrap = document.getElementById("ap-log-wrap");
            if (logWrap && cachedEntries.length > 0)
                logWrap.style.display = "block";
            if (
                done &&
                document.getElementById("ap-progress")?.style.display !== "none"
            ) {
                document.getElementById("ap-progress").style.display = "none";
                document.getElementById("ap-input").style.display = "block";
                document.getElementById("ap-done-msg").style.display = "block";
                document.getElementById("ap-done-msg").textContent =
                    `✅ All ${total} products scraped`;
            }
        }

        renderPanel();
        checkServer();
        setInterval(checkServer, 10000);
        setInterval(pollSession, 2000);

        return; // nothing else to do on the homepage
    }

    // ════════════════════════════════════════════════════════════
    // SCRAPER — runs on product pages (tabs opened by control panel)
    // ════════════════════════════════════════════════════════════

    const total = GM_getValue("total", 0);
    const managed = total > 0; // true when opened by the control panel

    if (managed) {
        const badge = document.createElement("div");
        badge.style.cssText = `
            position:fixed;top:12px;right:12px;z-index:99999;
            background:#232f3e;color:#fff;padding:6px 14px;
            border-radius:20px;font-family:sans-serif;font-size:13px;
            box-shadow:0 2px 8px rgba(0,0,0,.4);
        `;
        badge.textContent = `⏳ scraping... / ${total}`;
        document.body.appendChild(badge);
    }

    // ── 1. Force lazy-load by scrolling to A+ section ──
    // Target the OUTER feature wrapper first so we never accidentally land on
    // the brand story's inner <div id="aplus"> (both sections share that id).
    const aplusEl =
        document.getElementById("aplus_feature_div") ||
        document.getElementById("aplus3p_feature_div");
    if (aplusEl) aplusEl.scrollIntoView({ behavior: "instant" });

    // Strip brand story modules from a cloned element before saving.
    // Brand story can be nested inside #aplus or appear as a sibling section.
    function stripBrandModules(el) {
        if (!el) return "";
        const clone = el.cloneNode(true);
        const brandSelectors = [
            ".aplus-module-brand-story",
            "[class*='brand-story']",
            "[id*='brand-story']",
            "[id*='brandStory']",
            "[data-feature-name*='brand']",
            "#brand-story-btf",
            ".a-brand-story-background",
            ".brand-story-card",
        ];
        brandSelectors.forEach((sel) => {
            try {
                clone.querySelectorAll(sel).forEach((n) => n.remove());
            } catch (e) {}
        });
        return clone.innerHTML;
    }

    // Wait until the A+ module count stabilises — 3p/premium modules load
    // asynchronously AFTER standard ones, so we must not stop at the first image.
    // Strategy: poll every 500 ms; once the module count has been the same for
    // two consecutive checks (1 s of stability) we consider loading done.
    // Hard cap: 20 s.
    await (async function waitForModules() {
        const MAX = 20000;
        const start = Date.now();
        let lastCount = -1;
        let stableAt = 0;

        while (Date.now() - start < MAX) {
            // Query within aplusEl so we only count product-description modules
            const count = aplusEl
                ? aplusEl.querySelectorAll(".aplus-module").length
                : 0;

            if (count > 0 && count === lastCount) {
                if (!stableAt) stableAt = Date.now();
                if (Date.now() - stableAt >= 1000) return; // stable for 1 s
            } else {
                lastCount = count;
                stableAt = 0;
            }

            // Keep scrolling to wake lazy loaders for modules further down
            if (aplusEl) aplusEl.scrollIntoView({ behavior: "instant" });
            await sleep(500);
        }
    })();

    // ── 2. Detect A+ level — query within aplusEl (product description only) ──
    const modules = [
        ...(aplusEl ? aplusEl.querySelectorAll(".aplus-module") : []),
    ].filter(
        (m) =>
            !m.matches(
                ".aplus-module-brand-story, [class*='brand-story'], [id*='brand-story'], [id*='brandStory']",
            ) &&
            !m.closest(
                ".aplus-module-brand-story, [class*='brand-story'], [id*='brandStory']",
            ),
    );
    const premiumSignals = modules.filter(
        (m) =>
            m.querySelector("video") ||
            m.querySelector("[data-video-url]") ||
            m.querySelector(".aplus-carousel") ||
            m.className.includes("3p"),
    );
    const hasPremium = premiumSignals.length > 0;
    const hasAplus = modules.length > 0;
    const aplus_level = hasPremium
        ? "A+ Premium"
        : hasAplus
          ? "A+ Standard"
          : "None";

    // ── 3. Extract metadata ──
    const asin = (location.pathname.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
    if (!asin) {
        console.warn(
            "[A+ Scraper] Could not extract ASIN from",
            location.pathname,
        );
        if (managed) {
            window.close();
        }
        return;
    }

    const product_name =
        document.querySelector("#productTitle")?.textContent?.trim() || "";

    // ── Extract "About this item" feature bullets ──
    const feature_bullets = [
        ...document.querySelectorAll("#feature-bullets .a-list-item"),
    ]
        .map((el) => el.textContent.trim())
        .filter(Boolean)
        .join("\n");

    const bulletText =
        document.querySelector(
            "#productDetails_techSpec_section_1, #prodDetails, #detailBulletsWrapper_feature_div",
        )?.textContent || "";
    const skuMatch = bulletText.match(
        /(?:SKU|Item model number)[:\s]+([^\n]+)/i,
    );
    const sku = skuMatch ? skuMatch[1].trim() : "";

    // ── 4. Grab HTML — stripped of brand story modules ──
    // If level is None there is no product A+ content; save nothing so brand
    // story HTML from the same container isn't stored as product content.
    const aplus_html = aplus_level === "None" ? "" : stripBrandModules(aplusEl);

    // Recount modules from the cleaned HTML (exclude brand modules)
    const cleanModuleCount = aplusEl
        ? (() => {
              const clone = aplusEl.cloneNode(true);
              [
                  ".aplus-module-brand-story",
                  "[class*='brand-story']",
                  "[id*='brand-story']",
                  "[id*='brandStory']",
              ].forEach((sel) => {
                  try {
                      clone.querySelectorAll(sel).forEach((n) => n.remove());
                  } catch (e) {}
              });
              return clone.querySelectorAll(".aplus-module").length;
          })()
        : 0;

    // ── 5. POST to server, append to live log ──
    await new Promise((resolve) => {
        GM_xmlhttpRequest({
            method: "POST",
            url: "http://localhost:3003/api/products",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                asin,
                product_name,
                sku,
                aplus_level,
                aplus_html,
                module_count: cleanModuleCount,
                feature_bullets,
                sessionId: GM_getValue("sessionId", ""),
            }),
            onload: (r) => {
                console.log(
                    "[A+ Scraper] Saved:",
                    r.status,
                    asin,
                    r.status !== 200 ? r.responseText?.slice(0, 120) : "",
                );
                resolve();
            },
            onerror: (e) => {
                console.error("[A+ Scraper] Network error:", e);
                resolve();
            },
        });
    });

    // ── 6. Close tab if opened by control panel, otherwise stay ──
    if (managed) {
        window.close();
    }
})();
