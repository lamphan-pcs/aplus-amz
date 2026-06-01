require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "20mb" }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 3001;

// ── In-memory session tracking (resets on server restart) ────────────────────
const sessions = new Map();
const MAX_SESSIONS = 20;

// ── API: Create scrape session ──────────────────────────────────────────────
app.post("/api/session", (req, res) => {
    if (sessions.size >= MAX_SESSIONS)
        sessions.delete(sessions.keys().next().value);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    sessions.set(id, { done: 0, entries: [] });
    res.json({ sessionId: id });
});

// ── API: Get session progress ─────────────────────────────────────────────────
app.get("/api/session/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ done: 0, entries: [] });
    res.json({ done: s.done, entries: s.entries.slice(-100) });
});

// ── API: Check which ASINs are missing from the DB (for resume) ───────────────
app.post("/api/check-asins", async (req, res) => {
    const { asins } = req.body;
    if (!Array.isArray(asins) || asins.length === 0)
        return res.json({ missing: [], found: 0 });
    try {
        const result = await pool.query(
            `SELECT asin FROM products WHERE asin = ANY($1)`,
            [asins],
        );
        const found = new Set(result.rows.map((r) => r.asin));
        const missing = asins.filter((a) => !found.has(a));
        res.json({ missing, found: found.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── API: Upsert product (called by Tampermonkey) ──────────────────────────────
app.post("/api/products", async (req, res) => {
    const {
        asin,
        product_name,
        sku,
        aplus_level,
        aplus_html,
        module_count,
        feature_bullets,
        sessionId,
    } = req.body;

    if (!asin) return res.status(400).json({ error: "asin required" });

    try {
        await pool.query(
            `
            INSERT INTO products
                (asin, product_name, sku, aplus_level, aplus_html, feature_bullets, module_count, scraped_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7, now())
            ON CONFLICT (asin) DO UPDATE SET
                product_name    = EXCLUDED.product_name,
                sku             = EXCLUDED.sku,
                aplus_level     = EXCLUDED.aplus_level,
                aplus_html      = EXCLUDED.aplus_html,
                feature_bullets = EXCLUDED.feature_bullets,
                module_count    = EXCLUDED.module_count,
                scraped_at      = now()
        `,
            [
                asin,
                product_name,
                sku,
                aplus_level,
                aplus_html,
                feature_bullets || "",
                module_count || 0,
            ],
        );

        if (sessionId && sessions.has(sessionId)) {
            const s = sessions.get(sessionId);
            s.done++;
            s.entries.push({ asin, product_name, aplus_level, ok: true });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── API: List products (NO html columns for performance) ──────────────────────
app.get("/api/products", async (req, res) => {
    const { q, level } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (q) {
        params.push(q);
        conditions.push(
            `search_vector @@ websearch_to_tsquery('english', $${params.length})`,
        );
    }
    if (level) {
        params.push(level);
        conditions.push(`aplus_level = $${params.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    try {
        const countRes = await pool.query(
            `SELECT count(*)::int FROM products ${where}`,
            params,
        );
        params.push(limit, offset);
        const dataRes = await pool.query(
            `
            SELECT id, asin, product_name, sku, aplus_level, module_count, scraped_at, updated_at
            FROM products
            ${where}
            ORDER BY scraped_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
            params,
        );

        res.json({
            total: countRes.rows[0].count,
            page,
            pages: Math.ceil(countRes.rows[0].count / limit),
            results: dataRes.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── API: Single product (includes HTML) ──────────────────────────────────────
app.get("/api/products/:asin", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM products WHERE asin = $1",
            [req.params.asin],
        );
        if (!result.rows.length)
            return res.status(404).json({ error: "Not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Viewer: List page ─────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
    const { q = "", level = "" } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);

    let data = { total: 0, pages: 1, page: 1, results: [] };
    try {
        const params = [];
        const conditions = [];
        if (q) {
            params.push(q);
            conditions.push(
                `search_vector @@ websearch_to_tsquery('english', $${params.length})`,
            );
        }
        if (level) {
            params.push(level);
            conditions.push(`aplus_level = $${params.length}`);
        }
        const where = conditions.length
            ? "WHERE " + conditions.join(" AND ")
            : "";
        const limit = 50;
        const offset = (page - 1) * limit;
        const countRes = await pool.query(
            `SELECT count(*)::int FROM products ${where}`,
            params,
        );
        params.push(limit, offset);
        const dataRes = await pool.query(
            `
            SELECT id, asin, product_name, sku, aplus_level, module_count, scraped_at
            FROM products ${where}
            ORDER BY scraped_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
            params,
        );
        data = {
            total: countRes.rows[0].count,
            page,
            pages: Math.ceil(countRes.rows[0].count / limit),
            results: dataRes.rows,
        };
    } catch (err) {
        console.error(err);
    }

    const levelBadge = (l) => {
        const colors = {
            "A+ Premium": "#e65c00",
            "A+ Standard": "#1976d2",
            None: "#999",
        };
        return `<span style="background:${colors[l] || "#999"};color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8rem">${l}</span>`;
    };

    const rows = data.results
        .map(
            (p) => `
        <tr onclick="location.href='/product/${p.asin}'" style="cursor:pointer">
            <td>${escHtml(p.product_name || "-")}</td>
            <td><code>${p.asin}</code></td>
            <td>${escHtml(p.sku || "-")}</td>
            <td>${levelBadge(p.aplus_level)}</td>
            <td>${p.module_count || 0}</td>
            <td>${new Date(p.scraped_at).toLocaleDateString()}</td>
        </tr>`,
        )
        .join("");

    const pagerLinks = Array.from({ length: data.pages }, (_, i) => i + 1)
        .map(
            (
                n,
            ) => `<a href="/?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}&page=${n}"
            style="padding:4px 10px;margin:2px;background:${n == data.page ? "#1976d2" : "#eee"};color:${n == data.page ? "#fff" : "#333"};border-radius:4px;text-decoration:none">${n}</a>`,
        )
        .join(" ");

    res.send(
        `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>A+ Viewer</title>
    <style>
        body{font-family:sans-serif;max-width:1400px;margin:0 auto;padding:1rem;background:#f5f5f5}
        h1{color:#232f3e}
        form{display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap}
        input,select{padding:0.5rem;border:1px solid #ccc;border-radius:4px;font-size:1rem}
        input[type=text]{flex:1;min-width:200px}
        button{padding:0.5rem 1.2rem;background:#f90;border:none;border-radius:4px;cursor:pointer;font-weight:bold}
        table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
        th{background:#232f3e;color:#fff;padding:0.75rem 1rem;text-align:left}
        td{padding:0.65rem 1rem;border-bottom:1px solid #eee}
        tr:hover td{background:#fffbf0}
        .pager{margin-top:1rem}
    </style>
    </head><body>
    <h1>📦 A+ Content Viewer <small id="live-count" style="color:#999;font-size:1rem">${data.total} products</small> &nbsp;<a href="/all" style="font-size:0.9rem;font-weight:normal">View all content ↗</a> &nbsp;<button id="qs-run" type="button" style="font-size:0.85rem;padding:4px 12px;background:#1976d2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">🔍 Quality Scan</button> &nbsp;<button id="import-run" type="button" style="font-size:0.85rem;padding:4px 12px;background:#2e7d32;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">📥 Import SKUs</button> &nbsp;<button id="export-run" type="button" style="font-size:0.85rem;padding:4px 12px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">📤 Copy TSV</button></h1>

    <!-- Quality scan modal -->
    <div id="qs-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;overflow-y:auto">
      <div style="background:#fff;max-width:720px;margin:3rem auto;border-radius:10px;padding:1.5rem 2rem;position:relative">
        <button id="qs-close" type="button" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:#888">✕</button>
        <h2 style="margin:0 0 1rem;color:#232f3e">Quality Scan Results</h2>
        <div id="qs-body">Scanning…</div>
        <div id="qs-actions" style="display:none;margin-top:1rem;display:flex;gap:8px;flex-wrap:wrap">
          <button id="qs-copy" type="button" style="padding:6px 14px;background:#f90;border:none;border-radius:4px;cursor:pointer;font-weight:bold">📋 Copy URLs</button>
          <span style="font-size:0.82rem;color:#888;align-self:center">Paste into the Tampermonkey panel to re-scrape</span>
        </div>
      </div>
    </div>
    <script>
        var qsUrls = [];
        function runQualityScan() {
            console.log('runQualityScan started');
            document.getElementById('qs-overlay').style.display = 'block';
            document.getElementById('qs-body').innerHTML = '<p style="color:#888">Scanning all products…</p>';
            document.getElementById('qs-actions').style.display = 'none';
            fetch('/api/quality-scan').then(function(r){ return r.json(); }).then(function(d) {
                qsUrls = d.products.map(function(p){ return p.url; });
                if (d.bad === 0) {
                    document.getElementById('qs-body').innerHTML = '<p style="color:#2e7d32;font-weight:bold">✅ All ' + d.total + ' products look good!</p>';
                    return;
                }
                var rows = d.products.map(function(p) {
                    return '<tr><td style="padding:6px 8px"><a href="/product/' + p.asin + '" target="_blank">' + p.asin + '</a></td>'
                        + '<td style="padding:6px 8px;color:#555;font-size:0.85rem">' + (p.product_name || '-') + '</td>'
                        + '<td style="padding:6px 8px">' + p.reasons.map(function(r){ return '<span style="background:#fbe9e7;color:#c62828;padding:1px 6px;border-radius:3px;font-size:0.78rem">' + r + '</span>'; }).join(' ') + '</td></tr>';
                }).join('');
                document.getElementById('qs-body').innerHTML =
                    '<p style="color:#c62828;font-weight:bold">' + d.bad + ' of ' + d.total + ' products need re-scraping</p>'
                    + '<div style="max-height:400px;overflow-y:auto"><table style="width:100%;border-collapse:collapse">'
                    + '<thead><tr><th style="padding:6px 8px;background:#232f3e;color:#fff;text-align:left">ASIN</th><th style="padding:6px 8px;background:#232f3e;color:#fff;text-align:left">Product</th><th style="padding:6px 8px;background:#232f3e;color:#fff;text-align:left">Issue</th></tr></thead>'
                    + '<tbody>' + rows + '</tbody></table></div>';
                document.getElementById('qs-actions').style.display = 'flex';
            }).catch(function(e) {
                document.getElementById('qs-body').innerHTML = '<p style="color:#c62828">Error: ' + e.message + '</p>';
                console.error('Quality scan failed', e);
            });
        }
        function copyQsUrls(event) {
            navigator.clipboard.writeText(qsUrls.join('\\n')).then(function() {
                var btn = event.target;
                btn.textContent = '✅ Copied!';
                setTimeout(function(){ btn.textContent = '📋 Copy URLs'; }, 2000);
            });
        }
        document.getElementById('qs-run')?.addEventListener('click', runQualityScan);
        document.getElementById('qs-close')?.addEventListener('click', function() {
            document.getElementById('qs-overlay').style.display = 'none';
        });
        document.getElementById('qs-copy')?.addEventListener('click', copyQsUrls);
        document.getElementById('export-run')?.addEventListener('click', function() {
            var btn = this;
            btn.disabled = true; btn.textContent = '⏳ Copying…';
            fetch('/api/export-tsv').then(function(r){ return r.text(); }).then(function(tsv) {
                return navigator.clipboard.writeText(tsv);
            }).then(function() {
                btn.textContent = '✅ Copied!';
                setTimeout(function(){ btn.textContent = '📤 Copy TSV'; btn.disabled = false; }, 2000);
            }).catch(function() {
                btn.textContent = '❌ Failed'; btn.disabled = false;
            });
        });
    </script>

    <!-- Import SKUs modal -->
    <div id="import-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;overflow-y:auto">
      <div style="background:#fff;max-width:640px;margin:3rem auto;border-radius:10px;padding:1.5rem 2rem;position:relative">
        <button id="import-close" type="button" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:#888">✕</button>
        <h2 style="margin:0 0 0.5rem;color:#232f3e">Import SKUs</h2>
        <p style="color:#666;font-size:0.88rem;margin:0 0 0.75rem">Copy two columns from Excel / Google Sheets — <strong>SKU</strong> in column A and <strong>ASIN</strong> in column B — then paste below.</p>
        <textarea id="import-paste" rows="8" placeholder="SKU&#9;ASIN&#10;MY-SKU-01&#9;B08N5WRWNW" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;font-size:0.88rem;font-family:monospace;box-sizing:border-box;resize:vertical"></textarea>
        <div id="import-preview" style="display:none;margin-top:0.75rem;max-height:200px;overflow-y:auto;border:1px solid #eee;border-radius:4px"></div>
        <div style="display:flex;gap:8px;margin-top:1rem;align-items:center">
          <button id="import-confirm" type="button" style="padding:7px 18px;background:#2e7d32;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold">✅ Import</button>
          <button id="import-cancel" type="button" style="padding:7px 14px;background:#eee;border:none;border-radius:4px;cursor:pointer">Cancel</button>
          <span id="import-count" style="font-size:0.85rem;color:#888"></span>
        </div>
        <div id="import-result" style="display:none;margin-top:0.75rem"></div>
      </div>
    </div>
    <script>
        var importRows = [];
        function parseImportPaste(text) {
            var rows = [];
            text.trim().split('\\n').forEach(function(line) {
                var cols = line.split('\\t');
                var sku = (cols[0] || '').trim();
                var asin = (cols[1] || '').trim().toUpperCase();
                if (asin && /^[A-Z0-9]{10}$/.test(asin)) rows.push({ sku: sku, asin: asin });
            });
            return rows;
        }
        document.getElementById('import-paste').addEventListener('input', function() {
            importRows = parseImportPaste(this.value);
            var prev = document.getElementById('import-preview');
            var cnt = document.getElementById('import-count');
            if (importRows.length === 0) { prev.style.display = 'none'; cnt.textContent = ''; return; }
            cnt.textContent = importRows.length + ' row' + (importRows.length !== 1 ? 's' : '') + ' detected';
            prev.style.display = 'block';
            prev.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:0.82rem">'
                + '<thead><tr><th style="padding:4px 8px;background:#232f3e;color:#fff;text-align:left">SKU</th><th style="padding:4px 8px;background:#232f3e;color:#fff;text-align:left">ASIN</th></tr></thead>'
                + '<tbody>' + importRows.slice(0, 20).map(function(r) {
                    return '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">' + r.sku + '</td><td style="padding:4px 8px;border-bottom:1px solid #eee"><code>' + r.asin + '</code></td></tr>';
                }).join('') + (importRows.length > 20 ? '<tr><td colspan="2" style="padding:4px 8px;color:#aaa">… and ' + (importRows.length - 20) + ' more</td></tr>' : '') + '</tbody></table>';
        });
        document.getElementById('import-confirm').addEventListener('click', function() {
            if (!importRows.length) return;
            var btn = this;
            btn.disabled = true; btn.textContent = 'Importing…';
            fetch('/api/import-skus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: importRows })
            }).then(function(r) { return r.json(); }).then(function(d) {
                btn.disabled = false; btn.textContent = '✅ Import';
                var res = document.getElementById('import-result');
                res.style.display = 'block';
                var notFoundHtml = d.notFound && d.notFound.length
                    ? '<p style="color:#e65c00;font-size:0.85rem;margin:4px 0">Not found in DB: ' + d.notFound.join(', ') + '</p>' : '';
                res.innerHTML = '<p style="color:#2e7d32;font-weight:bold;margin:0 0 4px">✅ ' + d.updated + ' product' + (d.updated !== 1 ? 's' : '') + ' updated</p>' + notFoundHtml;
                if (d.updated > 0) setTimeout(function() { location.reload(); }, 1500);
            }).catch(function(e) {
                btn.disabled = false; btn.textContent = '✅ Import';
                alert('Import failed: ' + e.message);
            });
        });
        document.getElementById('import-run').addEventListener('click', function() {
            document.getElementById('import-overlay').style.display = 'block';
            document.getElementById('import-paste').value = '';
            document.getElementById('import-preview').style.display = 'none';
            document.getElementById('import-result').style.display = 'none';
            document.getElementById('import-count').textContent = '';
            importRows = [];
        });
        document.getElementById('import-close').addEventListener('click', function() {
            document.getElementById('import-overlay').style.display = 'none';
        });
        document.getElementById('import-cancel').addEventListener('click', function() {
            document.getElementById('import-overlay').style.display = 'none';
        });
    </script>

    <div id="live-bar" style="display:none;background:#232f3e;color:#fff;border-radius:6px;padding:6px 14px;margin-bottom:10px;font-size:13px"></div>
    <script>
        (function poll() {
            fetch('/api/stats').then(r => r.json()).then(s => {
                document.getElementById('live-count').textContent = s.total + ' products';
                var bar = document.getElementById('live-bar');
                if (s.last_hour > 0) {
                    bar.style.display = 'inline-block';
                    bar.textContent = '⚡ ' + s.last_hour + ' scraped in last hour — Premium: ' + s.premium + ' · Standard: ' + s.standard + ' · None: ' + s.none;
                } else { bar.style.display = 'none'; }
            }).catch(function(){});
            setTimeout(poll, 3000);
        })();
    </script>
    <form method="GET" action="/">
        <input type="text" name="q" placeholder="Search name, ASIN, SKU…" value="${escHtml(q)}">
        <select name="level">
            <option value="">All Levels</option>
            <option value="A+ Premium" ${level === "A+ Premium" ? "selected" : ""}>A+ Premium</option>
            <option value="A+ Standard" ${level === "A+ Standard" ? "selected" : ""}>A+ Standard</option>
            <option value="None" ${level === "None" ? "selected" : ""}>None</option>
        </select>
        <button type="submit">Search</button>
        ${q || level ? `<a href="/" style="padding:0.5rem;color:#e53935">✕ Clear</a>` : ""}
    </form>
    <table>
        <thead><tr>
            <th>Product Name</th><th>ASIN</th><th>SKU</th>
            <th>A+ Level</th><th>Modules</th><th>Scraped</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#999;padding:2rem">No products found</td></tr>'}</tbody>
    </table>
    <div class="pager">${pagerLinks}</div>
    </body></html>`,
    );
});

// ── Viewer: Detail page ───────────────────────────────────────────────────────
app.get("/product/:asin", async (req, res) => {
    let p;
    try {
        const r = await pool.query("SELECT * FROM products WHERE asin = $1", [
            req.params.asin,
        ]);
        if (!r.rows.length) return res.status(404).send("Not found");
        p = r.rows[0];
    } catch (err) {
        return res.status(500).send(err.message);
    }

    const levelColors = {
        "A+ Premium": "#e65c00",
        "A+ Standard": "#1976d2",
        None: "#999",
    };
    const levelBadge = `<span style="background:${levelColors[p.aplus_level] || "#999"};color:#fff;padding:2px 10px;border-radius:4px;font-size:0.85rem">${escHtml(p.aplus_level || "-")}</span>`;

    const section = (id, label, html, defaultOpen = true) => {
        const hasContent = html && html.trim().length > 0;
        return `
        <div class="section" id="sec-${id}">
            <div class="sec-header" onclick="toggleSection('${id}')">
                <span class="sec-title">${label}</span>
                <span class="sec-badge ${hasContent ? "has-content" : "no-content"}">${hasContent ? "Has content" : "Empty"}</span>
                <span class="sec-toggle" id="tog-${id}">${defaultOpen ? "▲ Hide" : "▼ Show"}</span>
            </div>
            <div class="sec-body" id="body-${id}" style="display:${defaultOpen ? "block" : "none"}">
                ${
                    hasContent
                        ? `<div class="iframe-wrap">
                        <iframe id="sec-iframe-${id}" srcdoc="${escAttr(stripNoscript(html))}"
                            style="width:100%;height:800px;border:none"
                            sandbox="allow-same-origin"
                            onload="onIframeLoad('${id}')"></iframe>
                       </div>`
                        : `<p class="empty-msg">No content captured for this section.</p>`
                }
            </div>
        </div>`;
    };

    const moduleTypes = parseModuleTypes(p.aplus_html);
    const moduleTypeButtonsHtml =
        moduleTypes.length > 0
            ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1rem;align-items:center">' +
              '<strong style="align-self:center;font-size:0.85rem;color:#555">Module types:</strong> ' +
              moduleTypes
                  .map((t) => {
                      const label = t
                          .replace(/^aplus-/, "")
                          .replace(/-/g, " ")
                          .replace(/\b\w/g, (l) => l.toUpperCase());
                      return `<button class="tog-btn active" data-mtype="${escHtml(t)}" onclick="toggleModuleType(this)">${escHtml(label)}</button>`;
                  })
                  .join("") +
              '<button class="tog-btn" style="margin-left:6px;border-color:#aaa" onclick="showAllModules()">Show all</button>' +
              '<button class="tog-btn" style="border-color:#aaa" onclick="hideAllModules()">Hide all</button>' +
              "</div>"
            : "";

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${escHtml(p.product_name || p.asin)}</title>
    <style>
        *{box-sizing:border-box}
        body{font-family:sans-serif;max-width:1400px;margin:0 auto;padding:1rem 1.5rem;background:#f5f5f5;color:#222}
        a{color:#1976d2;text-decoration:none}
        a:hover{text-decoration:underline}
        .back{font-size:0.9rem;margin-bottom:1rem;display:inline-block}
        h1{font-size:1.4rem;margin:0 0 1rem;color:#232f3e;line-height:1.3}
        .meta{background:#fff;padding:1.25rem 1.5rem;border-radius:8px;margin-bottom:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.1);display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start}
        .meta-table td:first-child{font-weight:600;color:#555;padding-right:1rem;white-space:nowrap;vertical-align:top}
        .meta-table td{padding:5px 0;font-size:0.9rem}
        .section{background:#fff;border-radius:8px;margin-bottom:1rem;box-shadow:0 1px 4px rgba(0,0,0,.1);overflow:hidden}
        .sec-header{display:flex;align-items:center;gap:10px;padding:0.9rem 1.25rem;cursor:pointer;user-select:none;border-bottom:1px solid transparent;transition:background 0.15s}
        .sec-header:hover{background:#fffbf0}
        .sec-title{font-weight:700;font-size:1rem;flex:1;color:#232f3e}
        .sec-badge{font-size:0.75rem;padding:2px 8px;border-radius:4px;color:#fff}
        .has-content{background:#2e7d32}
        .no-content{background:#999}
        .sec-toggle{font-size:0.8rem;color:#888;min-width:55px;text-align:right}
        .sec-body{border-top:1px solid #eee}
        .iframe-wrap{line-height:0}
        .empty-msg{color:#999;padding:1.5rem;font-style:italic;margin:0}
        .toggles{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1rem}
        .tog-btn{padding:5px 14px;border-radius:20px;border:1.5px solid #ccc;background:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;color:#555;transition:all 0.15s}
        .tog-btn.active{background:#232f3e;color:#fff;border-color:#232f3e}
    </style>
    </head><body>
    <a class="back" href="/">← Back to list</a>
    <h1>${escHtml(p.product_name || p.asin)}</h1>

    <div class="meta">
        <table class="meta-table">
            <tr><td>ASIN</td><td><code>${p.asin}</code> &nbsp;<a href="https://www.amazon.com/dp/${p.asin}" target="_blank">View on Amazon ↗</a></td></tr>
            <tr><td>SKU</td><td>${escHtml(p.sku || "—")}</td></tr>
            <tr><td>A+ Level</td><td>${levelBadge}</td></tr>
            <tr><td>Modules</td><td>${p.module_count || 0}</td></tr>
            <tr><td>Scraped</td><td>${new Date(p.scraped_at).toLocaleString()}</td></tr>
            <tr><td>Updated</td><td>${new Date(p.updated_at).toLocaleString()}</td></tr>
        </table>
    </div>

    <div class="toggles">
        <strong style="align-self:center;font-size:0.85rem;color:#555">Sections:</strong>
        <button class="tog-btn active" onclick="toggleSection('aplus')" id="tbtn-aplus">A+ Content</button>
    </div>

    ${moduleTypeButtonsHtml}

    ${section("aplus", "A+ Content", p.aplus_html, true)}

    <script>
        function toggleSection(id) {
            var body = document.getElementById('body-' + id);
            var tog = document.getElementById('tog-' + id);
            var btn = document.getElementById('tbtn-' + id);
            var open = body.style.display === 'none';
            body.style.display = open ? 'block' : 'none';
            tog.textContent = open ? '▲ Hide' : '▼ Show';
            if (btn) { btn.classList.toggle('active', open); }
        }

        var hiddenModuleTypes = new Set();

        function onIframeLoad(sectionId) {
            if (sectionId === 'aplus') applyModuleFilters();
        }

        function applyModuleFilters() {
            var iframe = document.getElementById('sec-iframe-aplus');
            if (!iframe || !iframe.contentDocument || !iframe.contentDocument.head) return;
            var style = iframe.contentDocument.getElementById('__mf__');
            if (!style) {
                style = iframe.contentDocument.createElement('style');
                style.id = '__mf__';
                iframe.contentDocument.head.appendChild(style);
            }
            style.textContent = Array.from(hiddenModuleTypes)
                .map(function(t) { return '[cel_widget_id="' + t + '"] { display:none !important; }'; })
                .join('\\n');
        }

        function toggleModuleType(btn) {
            var type = btn.dataset.mtype;
            if (hiddenModuleTypes.has(type)) {
                hiddenModuleTypes.delete(type);
                btn.classList.add('active');
            } else {
                hiddenModuleTypes.add(type);
                btn.classList.remove('active');
            }
            applyModuleFilters();
        }

        function showAllModules() {
            hiddenModuleTypes.clear();
            document.querySelectorAll('[data-mtype]').forEach(function(b) { b.classList.add('active'); });
            applyModuleFilters();
        }

        function hideAllModules() {
            document.querySelectorAll('[data-mtype]').forEach(function(b) {
                hiddenModuleTypes.add(b.dataset.mtype);
                b.classList.remove('active');
            });
            applyModuleFilters();
        }
    <\/script>
    </body></html>`);
});

// ── Viewer: All products scroll page ─────────────────────────────────────────
app.get("/all", async (req, res) => {
    const { q = "", level = "", section = "aplus" } = req.query;
    let products = [];
    try {
        const params = [];
        const conditions = [];
        if (q) {
            params.push(q);
            conditions.push(
                `search_vector @@ websearch_to_tsquery('english', $${params.length})`,
            );
        }
        if (level) {
            params.push(level);
            conditions.push(`aplus_level = $${params.length}`);
        }
        const where = conditions.length
            ? "WHERE " + conditions.join(" AND ")
            : "";
        const result = await pool.query(
            `SELECT asin, product_name, sku, aplus_level, has_brand_story, module_count, aplus_html, brand_story_html, scraped_at
             FROM products ${where}
             ORDER BY scraped_at DESC`,
            params,
        );
        products = result.rows;
    } catch (err) {
        console.error(err);
    }

    const levelColors = {
        "A+ Premium": "#e65c00",
        "A+ Standard": "#1976d2",
        None: "#999",
    };

    const cards = products
        .filter((p) => (p.aplus_html || "").trim().length > 0)
        .map((p) => {
            const html = p.aplus_html || "";
            const hasContent = true;
            const cardMtypes = parseModuleTypes(p.aplus_html).join(",");
            return `
        <div class="card" id="card-${p.asin}" data-mtypes="${escAttr(cardMtypes)}">
            <div class="card-header">
                <div class="card-meta">
                    <a class="card-name" href="/product/${p.asin}">${escHtml(p.product_name || p.asin)}</a>
                    <div class="card-sub">
                        <code>${p.asin}</code>
                        ${p.sku ? `<span class="dot">·</span><span>${escHtml(p.sku)}</span>` : ""}
                        <span class="dot">·</span>
                        <span style="background:${levelColors[p.aplus_level] || "#999"};color:#fff;padding:1px 8px;border-radius:4px;font-size:0.75rem">${escHtml(p.aplus_level)}</span>
                        ${p.has_brand_story ? `<span class="dot">·</span><span style="font-size:0.8rem">Brand Story ✅</span>` : ""}
                        <span class="dot">·</span><span style="font-size:0.8rem;color:#aaa">${p.module_count || 0} modules</span>
                    </div>
                </div>
                <button class="collapse-btn" onclick="toggleCard('${p.asin}')" id="cbtn-${p.asin}">▲ Collapse</button>
            </div>
            <div class="card-body" id="cbody-${p.asin}">
                ${
                    hasContent
                        ? `<iframe id="iframe-${p.asin}" srcdoc="${escAttr(stripNoscript(html))}" style="width:100%;height:800px;border:none" sandbox="allow-same-origin" loading="lazy" onload="onIframeLoad('${p.asin}')"></iframe>`
                        : `<p class="empty">No content captured for this section.</p>`
                }
            </div>
        </div>`;
        })
        .join("");

    // Collect all unique module types across products for the global filter bar
    const allModuleTypes = [
        ...new Set(products.flatMap((p) => parseModuleTypes(p.aplus_html))),
    ].sort();

    const moduleBarHtml =
        allModuleTypes.length > 0
            ? `<div class="module-bar">
            <span class="module-bar-label">Module types:</span>
            ${allModuleTypes
                .map((t) => {
                    const label = t
                        .replace(/^aplus-/, "")
                        .replace(/-/g, " ")
                        .replace(/\b\w/g, (l) => l.toUpperCase());
                    return `<button class="tog-btn active" data-mtype="${escAttr(t)}" onclick="toggleModuleType(this)">${escHtml(label)}</button>`;
                })
                .join("")}
            <button class="tog-btn" style="margin-left:6px;border-color:#aaa" onclick="showAllModules()">Show all</button>
            <button class="tog-btn" style="border-color:#aaa" onclick="hideAllModules()">Hide all</button>
          </div>`
            : "";

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>All A+ Content</title>
    <style>
        *{box-sizing:border-box}
        body{font-family:sans-serif;max-width:1400px;margin:0 auto;padding:1rem 1.5rem;background:#f5f5f5;color:#222}
        a{color:#1976d2;text-decoration:none}
        a:hover{text-decoration:underline}
        .toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:1rem;background:#fff;padding:0.75rem 1rem;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
        .toolbar form{display:contents}
        input[type=text]{padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:0.9rem;flex:1;min-width:160px}
        select,button{padding:6px 12px;border:1px solid #ccc;border-radius:4px;font-size:0.9rem;background:#fff;cursor:pointer}
        button.primary{background:#f90;border-color:#f90;font-weight:bold;color:#111}
        .seg{display:flex;border:1.5px solid #232f3e;border-radius:6px;overflow:hidden}
        .seg a{padding:5px 14px;font-size:0.85rem;font-weight:600;color:#232f3e;white-space:nowrap}
        .seg a.active{background:#232f3e;color:#fff}
        .summary{font-size:0.85rem;color:#888;margin-left:auto}
        .collapse-all-btn{padding:5px 12px;background:#eee;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:0.82rem}
        .module-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:1rem;background:#fff;padding:0.65rem 1rem;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
        .module-bar-label{font-size:0.85rem;font-weight:600;color:#555;white-space:nowrap}
        .tog-btn{padding:5px 14px;border-radius:20px;border:1.5px solid #ccc;background:#fff;cursor:pointer;font-size:0.82rem;font-weight:600;color:#555;transition:all 0.15s}
        .tog-btn.active{background:#232f3e;color:#fff;border-color:#232f3e}
        .card{background:#fff;border-radius:8px;margin-bottom:1rem;box-shadow:0 1px 4px rgba(0,0,0,.1);overflow:hidden}
        .card-header{display:flex;align-items:flex-start;gap:10px;padding:0.85rem 1.25rem;border-bottom:1px solid #eee}
        .card-meta{flex:1;min-width:0}
        .card-name{font-weight:700;font-size:1rem;color:#232f3e;display:block;margin-bottom:4px}
        .card-sub{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:0.82rem;color:#555}
        .dot{color:#ccc}
        .collapse-btn{padding:4px 10px;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:0.8rem;background:#f9f9f9;white-space:nowrap;flex-shrink:0}
        .card-body{line-height:0}
        .empty{color:#999;font-style:italic;padding:1.5rem;margin:0;line-height:1.5}
        .empty-state{text-align:center;padding:4rem;color:#aaa}
    </style>
    </head><body>
    <div class="toolbar">
        <a href="/" style="font-weight:700;color:#232f3e;white-space:nowrap">📦 A+ Viewer</a>
        <form method="GET" action="/all" style="display:contents">
            <input type="hidden" name="section" value="${escHtml(section)}">
            <input type="text" name="q" placeholder="Search name, ASIN, SKU…" value="${escHtml(q)}">
            <select name="level">
                <option value="">All Levels</option>
                <option value="A+ Premium" ${level === "A+ Premium" ? "selected" : ""}>A+ Premium</option>
                <option value="A+ Standard" ${level === "A+ Standard" ? "selected" : ""}>A+ Standard</option>
                <option value="None" ${level === "None" ? "selected" : ""}>None</option>
            </select>
            <button class="primary" type="submit">Search</button>
            ${q || level ? `<a href="/all?section=${encodeURIComponent(section)}" style="font-size:0.85rem;color:#e53935">✕ Clear</a>` : ""}
        </form>
        <div class="seg">
            <a href="/all?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}&section=aplus" class="active">A+ Content</a>
        </div>
        <span class="summary">${products.length} product${products.length !== 1 ? "s" : ""}</span>
        <button class="collapse-all-btn" onclick="collapseAll()">Collapse all</button>
        <button class="collapse-all-btn" onclick="expandAll()">Expand all</button>
    </div>

    ${moduleBarHtml}

    ${cards || `<div class="empty-state"><p>No products found.</p><a href="/all">Clear filters</a></div>`}

    <script>
        var collapsed = {};
        var hiddenModuleTypes = new Set();

        function applyModuleFilters() {
            var css = Array.from(hiddenModuleTypes)
                .map(function(t) { return '[cel_widget_id="' + t + '"] { display:none !important; }'; })
                .join(' ');
            document.querySelectorAll('iframe[id^="iframe-"]').forEach(function(iframe) {
                try {
                    var doc = iframe.contentDocument;
                    if (!doc || !doc.head) return;
                    var s = doc.getElementById('__mf__');
                    if (!s) { s = doc.createElement('style'); s.id = '__mf__'; doc.head.appendChild(s); }
                    s.textContent = css;
                } catch(e) {}
            });
            document.querySelectorAll('.card[data-mtypes]').forEach(function(card) {
                var mtypes = card.dataset.mtypes ? card.dataset.mtypes.split(',').filter(Boolean) : [];
                var allHidden = mtypes.length > 0 && mtypes.every(function(t) { return hiddenModuleTypes.has(t); });
                card.style.display = allHidden ? 'none' : '';
            });
        }

        function onIframeLoad(asin) {
            applyModuleFilters();
        }

        function toggleModuleType(btn) {
            var type = btn.dataset.mtype;
            if (hiddenModuleTypes.has(type)) {
                hiddenModuleTypes.delete(type);
                btn.classList.add('active');
            } else {
                hiddenModuleTypes.add(type);
                btn.classList.remove('active');
            }
            applyModuleFilters();
        }

        function showAllModules() {
            hiddenModuleTypes.clear();
            document.querySelectorAll('[data-mtype]').forEach(function(b) { b.classList.add('active'); });
            applyModuleFilters();
        }

        function hideAllModules() {
            document.querySelectorAll('[data-mtype]').forEach(function(b) {
                hiddenModuleTypes.add(b.dataset.mtype);
                b.classList.remove('active');
            });
            applyModuleFilters();
        }

        function toggleCard(asin) {
            var body = document.getElementById('cbody-' + asin);
            var btn = document.getElementById('cbtn-' + asin);
            var open = body.style.display === 'none';
            body.style.display = open ? 'block' : 'none';
            btn.textContent = open ? '▲ Collapse' : '▼ Expand';
            collapsed[asin] = !open;
        }
        function collapseAll() {
            document.querySelectorAll('[id^="cbody-"]').forEach(function(el) {
                var asin = el.id.replace('cbody-', '');
                el.style.display = 'none';
                var btn = document.getElementById('cbtn-' + asin);
                if (btn) btn.textContent = '▼ Expand';
            });
        }
        function expandAll() {
            document.querySelectorAll('[id^="cbody-"]').forEach(function(el) {
                var asin = el.id.replace('cbody-', '');
                el.style.display = 'block';
                var btn = document.getElementById('cbtn-' + asin);
                if (btn) btn.textContent = '▲ Collapse';
            });
        }
    <\/script>
    </body></html>`);
});

// ── API: Stats (for live viewer counter) ─────────────────────────────────────
app.get("/api/quality-scan", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT asin, product_name, aplus_html FROM products WHERE aplus_html IS NOT NULL AND length(aplus_html) > 50 AND aplus_level != 'None'`,
        );
        const bad = [];
        for (const p of result.rows) {
            const html = p.aplus_html || "";
            const reasons = [];
            if (/from the brand/i.test(html))
                reasons.push('Contains "From the brand" header');
            // has aplus-module divs but zero <img> tags = images never loaded
            if (/aplus-module/i.test(html) && !/<img[\s>]/i.test(html))
                reasons.push("No images in A+ modules");
            if (reasons.length > 0) {
                bad.push({
                    asin: p.asin,
                    product_name: p.product_name,
                    reasons,
                    url: `https://www.amazon.com/dp/${p.asin}`,
                });
            }
        }
        res.json({ total: result.rows.length, bad: bad.length, products: bad });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/import-skus", async (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ error: "rows required" });
    let updated = 0;
    const notFound = [];
    try {
        for (const { sku, asin } of rows) {
            if (!asin) continue;
            const r = await pool.query(
                "UPDATE products SET sku = $1, updated_at = now() WHERE asin = $2",
                [(sku || "").trim(), asin.trim().toUpperCase()],
            );
            if (r.rowCount > 0) updated++;
            else notFound.push(asin.trim().toUpperCase());
        }
        res.json({ updated, notFound });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/export-tsv", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT sku, asin, product_name, aplus_level, feature_bullets FROM products ORDER BY scraped_at DESC`,
        );
        // Wrap a cell value in quotes if it contains newlines or quote chars,
        // so Google Sheets renders multi-line bullets correctly.
        function tsvCell(v) {
            const s = String(v == null ? "" : v).replace(/\t/g, " ");
            if (s.includes("\n") || s.includes('"')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        }
        const lines = [
            ["SKU", "ASIN", "Product Name", "A+ Level", "Feature Bullets"].join(
                "\t",
            ),
            ...result.rows.map((p) =>
                [
                    p.sku || "",
                    p.asin,
                    p.product_name || "",
                    p.aplus_level || "",
                    p.feature_bullets || "",
                ]
                    .map(tsvCell)
                    .join("\t"),
            ),
        ];
        res.setHeader(
            "Content-Type",
            "text/tab-separated-values; charset=utf-8",
        );
        res.setHeader(
            "Content-Disposition",
            'attachment; filename="aplus-export.tsv"',
        );
        res.send(lines.join("\n"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/stats", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                count(*)::int                                                        AS total,
                count(*) FILTER (WHERE aplus_level = 'A+ Premium')::int              AS premium,
                count(*) FILTER (WHERE aplus_level = 'A+ Standard')::int             AS standard,
                count(*) FILTER (WHERE aplus_level = 'None')::int                    AS none,
                count(*) FILTER (WHERE scraped_at > now() - interval '1 hour')::int  AS last_hour
            FROM products
        `);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function parseModuleTypes(html) {
    if (!html) return [];
    const types = new Set();
    const re = /<div\b[^>]*\baplus-module\b[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const wm = m[0].match(/\bcel_widget_id="([^"]+)"/);
        if (wm && wm[1] !== "aplus") types.add(wm[1]);
    }
    return [...types].sort();
}

function escHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function escAttr(s) {
    return escHtml(s).replace(/'/g, "&#39;");
}
// Strip <noscript> blocks so sandboxed iframes (no JS) don't render them twice
function stripNoscript(html) {
    return (html || "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
}

app.listen(PORT, () =>
    console.log(`A+ Viewer running at http://localhost:${PORT}`),
);
