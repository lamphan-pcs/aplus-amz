# Amazon A+ Scraper — Implementation Guide

## Project Location
`D:\amazon\git\aplus` — standalone project, does NOT touch `D:\e-label\`

## Stack
- Node.js + Express (port 3001)
- pg (node-postgres)
- PostgreSQL (local)
- Tampermonkey (browser script)

---

## Step 1 — Scaffold the project

```bash
mkdir D:\amazon\git\aplus
cd D:\amazon\git\aplus
npm init -y
npm install express pg dotenv
```

Create `.env`:
```
DATABASE_URL=postgresql://youruser:yourpassword@localhost:5432/yourdb
PORT=3001
```

---

## Step 2 — schema.sql (run once in psql)

```sql
CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    asin            VARCHAR(10)  UNIQUE NOT NULL,
    product_name    TEXT,
    sku             TEXT,
    aplus_level     VARCHAR(20)  DEFAULT 'None',   -- 'None' | 'A+ Standard' | 'A+ Premium'
    has_brand_story BOOLEAN      DEFAULT false,
    aplus_html      TEXT,
    brand_story_html TEXT,
    module_count    INT          DEFAULT 0,
    scraped_at      TIMESTAMPTZ  DEFAULT now(),
    updated_at      TIMESTAMPTZ  DEFAULT now(),
    search_vector   TSVECTOR
);

-- GIN index for full-text search (fast even with 100k+ rows)
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN (search_vector);

-- Index for filtering by level
CREATE INDEX IF NOT EXISTS idx_products_level ON products (aplus_level);

-- Function to rebuild search_vector from name + asin + sku
CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.product_name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.asin, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.sku, '')), 'B');
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger fires on every insert or update
DROP TRIGGER IF EXISTS products_search_vector_trigger ON products;
CREATE TRIGGER products_search_vector_trigger
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();
```

Run it:
```bash
psql -U youruser -d yourdb -f schema.sql
```

---

## Step 3 — server.js

```js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '20mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 3001;

// ── API: Upsert product (called by Tampermonkey) ──────────────────────────────
app.post('/api/products', async (req, res) => {
    const {
        asin, product_name, sku,
        aplus_level, has_brand_story,
        aplus_html, brand_story_html, module_count
    } = req.body;

    if (!asin) return res.status(400).json({ error: 'asin required' });

    try {
        await pool.query(`
            INSERT INTO products
                (asin, product_name, sku, aplus_level, has_brand_story, aplus_html, brand_story_html, module_count, scraped_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
            ON CONFLICT (asin) DO UPDATE SET
                product_name    = EXCLUDED.product_name,
                sku             = EXCLUDED.sku,
                aplus_level     = EXCLUDED.aplus_level,
                has_brand_story = EXCLUDED.has_brand_story,
                aplus_html      = EXCLUDED.aplus_html,
                brand_story_html= EXCLUDED.brand_story_html,
                module_count    = EXCLUDED.module_count,
                scraped_at      = now()
        `, [asin, product_name, sku, aplus_level, has_brand_story, aplus_html, brand_story_html, module_count || 0]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── API: List products (NO html columns for performance) ──────────────────────
app.get('/api/products', async (req, res) => {
    const { q, level, page = 1 } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;
    const params = [];
    const conditions = [];

    if (q) {
        params.push(q);
        conditions.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
    }
    if (level) {
        params.push(level);
        conditions.push(`aplus_level = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    try {
        const countRes = await pool.query(
            `SELECT count(*)::int FROM products ${where}`, params
        );
        params.push(limit, offset);
        const dataRes = await pool.query(`
            SELECT id, asin, product_name, sku, aplus_level, has_brand_story, module_count, scraped_at, updated_at
            FROM products
            ${where}
            ORDER BY scraped_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);

        res.json({
            total: countRes.rows[0].count,
            page: parseInt(page),
            pages: Math.ceil(countRes.rows[0].count / limit),
            results: dataRes.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── API: Single product (includes HTML) ──────────────────────────────────────
app.get('/api/products/:asin', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE asin = $1', [req.params.asin]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Viewer: List page ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    const { q = '', level = '', page = 1 } = req.query;

    let data = { total: 0, pages: 1, page: 1, results: [] };
    try {
        const params = [];
        const conditions = [];
        if (q) { params.push(q); conditions.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`); }
        if (level) { params.push(level); conditions.push(`aplus_level = $${params.length}`); }
        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
        const limit = 50;
        const offset = (parseInt(page) - 1) * limit;
        const countRes = await pool.query(`SELECT count(*)::int FROM products ${where}`, params);
        params.push(limit, offset);
        const dataRes = await pool.query(`
            SELECT id, asin, product_name, sku, aplus_level, has_brand_story, module_count, scraped_at
            FROM products ${where}
            ORDER BY scraped_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);
        data = {
            total: countRes.rows[0].count,
            page: parseInt(page),
            pages: Math.ceil(countRes.rows[0].count / limit),
            results: dataRes.rows
        };
    } catch (err) { console.error(err); }

    const levelBadge = (l) => {
        const colors = { 'A+ Premium': '#e65c00', 'A+ Standard': '#1976d2', 'None': '#999' };
        return `<span style="background:${colors[l]||'#999'};color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8rem">${l}</span>`;
    };

    const rows = data.results.map(p => `
        <tr onclick="location.href='/product/${p.asin}'" style="cursor:pointer">
            <td>${escHtml(p.product_name || '-')}</td>
            <td><code>${p.asin}</code></td>
            <td>${escHtml(p.sku || '-')}</td>
            <td>${levelBadge(p.aplus_level)}</td>
            <td>${p.has_brand_story ? '✅' : ''}</td>
            <td>${p.module_count || 0}</td>
            <td>${new Date(p.scraped_at).toLocaleDateString()}</td>
        </tr>`).join('');

    const pagerLinks = Array.from({ length: data.pages }, (_, i) => i + 1)
        .map(n => `<a href="/?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}&page=${n}"
            style="padding:4px 10px;margin:2px;background:${n==data.page?'#1976d2':'#eee'};color:${n==data.page?'#fff':'#333'};border-radius:4px;text-decoration:none">${n}</a>`)
        .join(' ');

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
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
    <h1>📦 A+ Content Viewer <small style="color:#999;font-size:1rem">${data.total} products</small></h1>
    <form method="GET" action="/">
        <input type="text" name="q" placeholder="Search name, ASIN, SKU…" value="${escHtml(q)}">
        <select name="level">
            <option value="">All Levels</option>
            <option value="A+ Premium" ${level==='A+ Premium'?'selected':''}>A+ Premium</option>
            <option value="A+ Standard" ${level==='A+ Standard'?'selected':''}>A+ Standard</option>
            <option value="None" ${level==='None'?'selected':''}>None</option>
        </select>
        <button type="submit">Search</button>
        ${q||level ? `<a href="/" style="padding:0.5rem;color:#e53935">✕ Clear</a>` : ''}
    </form>
    <table>
        <thead><tr>
            <th>Product Name</th><th>ASIN</th><th>SKU</th>
            <th>A+ Level</th><th>Brand Story</th><th>Modules</th><th>Scraped</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#999;padding:2rem">No products found</td></tr>'}</tbody>
    </table>
    <div class="pager">${pagerLinks}</div>
    </body></html>`);
});

// ── Viewer: Detail page ───────────────────────────────────────────────────────
app.get('/product/:asin', async (req, res) => {
    let p;
    try {
        const r = await pool.query('SELECT * FROM products WHERE asin = $1', [req.params.asin]);
        if (!r.rows.length) return res.status(404).send('Not found');
        p = r.rows[0];
    } catch (err) { return res.status(500).send(err.message); }

    const iframeSrc = (html) => html
        ? `<iframe srcdoc="${escAttr(html)}" style="width:100%;height:800px;border:1px solid #ddd;border-radius:4px" sandbox="allow-same-origin"></iframe>`
        : '<p style="color:#999">No content</p>';

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${escHtml(p.product_name || p.asin)}</title>
    <style>
        body{font-family:sans-serif;max-width:1300px;margin:0 auto;padding:1rem;background:#f5f5f5}
        .meta{background:#fff;padding:1.5rem;border-radius:8px;margin-bottom:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.1)}
        .meta table td:first-child{font-weight:bold;color:#555;width:160px}
        .meta table td{padding:6px 12px}
        h2{color:#232f3e;margin-top:2rem}
        a{color:#1976d2}
    </style>
    </head><body>
    <p><a href="/">← Back to list</a></p>
    <h1>${escHtml(p.product_name || p.asin)}</h1>
    <div class="meta">
        <table>
            <tr><td>ASIN</td><td><code>${p.asin}</code> — <a href="https://www.amazon.com/dp/${p.asin}" target="_blank">View on Amazon ↗</a></td></tr>
            <tr><td>SKU</td><td>${escHtml(p.sku || '-')}</td></tr>
            <tr><td>A+ Level</td><td>${escHtml(p.aplus_level || '-')}</td></tr>
            <tr><td>Brand Story</td><td>${p.has_brand_story ? '✅ Yes' : 'No'}</td></tr>
            <tr><td>Modules</td><td>${p.module_count || 0}</td></tr>
            <tr><td>Scraped</td><td>${new Date(p.scraped_at).toLocaleString()}</td></tr>
            <tr><td>Updated</td><td>${new Date(p.updated_at).toLocaleString()}</td></tr>
        </table>
    </div>
    <h2>A+ Content</h2>
    ${iframeSrc(p.aplus_html)}
    ${p.has_brand_story ? `<h2>Brand Story</h2>${iframeSrc(p.brand_story_html)}` : ''}
    </body></html>`);
});

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return escHtml(s).replace(/'/g,'&#39;'); }

app.listen(PORT, () => console.log(`A+ Viewer running at http://localhost:${PORT}`));
```

> **Note:** The list-page handler duplicates the query logic from `/api/products` for simplicity. Extract into a `queryProducts(q, level, page)` helper if preferred.

---

## Step 4 — tampermonkey.js

```js
// ==UserScript==
// @name         Amazon A+ Scraper
// @namespace    http://tampermonkey.net/
// @version      1.0
// @match        https://www.amazon.com/dp/*
// @match        https://www.amazon.com/*/dp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// ==/UserScript==

(async () => {
    // ── 1. Force lazy-load by scrolling to A+ section ──
    const aplusEl = document.querySelector('#aplus, #aplus_feature_div');
    const brandEl = document.querySelector('#aplusBrandStory_feature_div');
    if (aplusEl) aplusEl.scrollIntoView({ behavior: 'instant' });
    if (brandEl) brandEl.scrollIntoView({ behavior: 'instant' });

    await sleep(3000); // wait for lazy content to render

    // ── 2. Detect A+ level ──
    const modules = [...document.querySelectorAll('#aplus .aplus-module')];
    const premiumSignals = modules.filter(m =>
        m.querySelector('video') ||
        m.querySelector('[data-video-url]') ||
        m.querySelector('.aplus-carousel') ||
        m.className.includes('3p')
    );
    const hasPremium  = premiumSignals.length > 0;
    const hasAplus    = modules.length > 0;
    const aplus_level = hasPremium ? 'A+ Premium' : hasAplus ? 'A+ Standard' : 'None';

    const hasBrandStory = !!document.querySelector(
        '#aplusBrandStory_feature_div .aplus-brand-story-card, ' +
        '#aplusBrandStory_feature_div .apm-brand-story-card'
    );

    // ── 3. Extract metadata ──
    const asin = (location.pathname.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
    if (!asin) return console.warn('[A+ Scraper] Could not extract ASIN');

    const product_name = document.querySelector('#productTitle')?.textContent?.trim() || '';

    // SKU — try product details section
    const bulletText = document.querySelector(
        '#productDetails_techSpec_section_1, #prodDetails, #detailBulletsWrapper_feature_div'
    )?.textContent || '';
    const skuMatch = bulletText.match(/(?:SKU|Item model number)[:\s]+([^\n]+)/i);
    const sku = skuMatch ? skuMatch[1].trim() : '';

    // ── 4. Grab HTML ──
    const aplus_html       = aplusEl?.innerHTML || '';
    const brand_story_html = brandEl?.innerHTML || '';

    // ── 5. POST to local server ──
    GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://localhost:3001/api/products',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
            asin, product_name, sku,
            aplus_level,
            has_brand_story: hasBrandStory,
            aplus_html,
            brand_story_html,
            module_count: modules.length
        }),
        onload:  (r) => console.log('[A+ Scraper] Saved:', r.status, asin),
        onerror: (e) => console.error('[A+ Scraper] Error:', e),
    });

    // ── Bulk mode: auto-advance through a stored URL list ──
    const urls  = GM_getValue('urls', []);
    const index = GM_getValue('index', -1);
    if (index >= 0 && index < urls.length - 1) {
        GM_setValue('index', index + 1);
        await sleep(4000 + Math.random() * 2000); // 4–6s jitter
        location.href = urls[index + 1];
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
```

**To start a bulk run** — paste in browser console on any Amazon page:
```js
GM_setValue('urls', ['https://amazon.com/dp/ASIN1', 'https://amazon.com/dp/ASIN2']);
GM_setValue('index', 0);
location.href = GM_getValue('urls')[0];
```

---

## Step 5 — package.json

```json
{
  "name": "aplus-scraper",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "dotenv": "^16.0.0",
    "express": "^5.0.0",
    "pg": "^8.0.0"
  }
}
```

---

## Verification Checklist

1. `psql -U user -d db -f schema.sql` → no errors, `\d products` shows all columns + indexes
2. `curl -X POST http://localhost:3001/api/products -H "Content-Type: application/json" -d "{\"asin\":\"B0TEST1234\",\"product_name\":\"Test\",\"sku\":\"SKU-1\",\"aplus_level\":\"A+ Standard\",\"has_brand_story\":false,\"module_count\":3}"` → `{"success":true}`
3. Same curl again → still `{"success":true}` (upsert, not duplicate)
4. `curl "http://localhost:3001/api/products?q=Test"` → returns row **without** HTML columns
5. `http://localhost:3001/` → table renders, search filters, pagination works
6. Click a row → detail page loads with A+ HTML rendered in sandboxed iframe
7. Install Tampermonkey script, visit an Amazon product page, check console for `[A+ Scraper] Saved: 200`, refresh viewer
