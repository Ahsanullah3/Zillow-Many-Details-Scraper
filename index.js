// =========================================================
// ZILLOW SCRAPER — CHROME-ONLY, STEALTH, PARALLEL WORKERS
// - puppeteer-extra + stealth plugin (restored)
// - N parallel Chrome workers, each claims a DIFFERENT row
// - Optional SHARD_INDEX / SHARD_COUNT to split rows across
//   multiple GitHub Actions jobs running at the same time
// - Price history: zoom trick + Table view + expanders + looped
//   "Show more" (no GraphQL fallback — it triggered blocks)
// - Graceful cancel on SIGTERM/SIGINT/SIGHUP
// =========================================================

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

// =========================================================
// GRACEFUL CANCEL
// =========================================================
let SHUTDOWN_REQUESTED = false;
const shutdown = (signal) => {
    if (SHUTDOWN_REQUESTED) return;
    SHUTDOWN_REQUESTED = true;
    console.log(`\n🛑 Received ${signal} — shutting down cleanly...`);
    setTimeout(() => {
        console.log('💥 Forcing exit after 8s grace period');
        process.exit(0);
    }, 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

// =========================================================
// CONFIG
// =========================================================
const CONCURRENCY = Number(process.env.CONCURRENCY || '5');          // parallel Chrome workers per job
const MAX_URLS_PER_RUN = Number(process.env.MAX_URLS_PER_RUN || '150');
const FLUSH_EVERY = Number(process.env.FLUSH_EVERY || '5');
const REQUIRED_COLS = 34;
const MAX_CONSECUTIVE_BLOCK_STREAKS = Number(process.env.MAX_BLOCK_STREAK || '6');
const MAX_CONSECUTIVE_ERRORS = 6;
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 60 * 60 * 1000);
const RECYCLE_BROWSER_EVERY = Number(process.env.RECYCLE_BROWSER_EVERY || '10');

// ---- Sharding: run several Actions jobs at once, each on different rows ----
// Job k of N processes only rows where (rowIndex % N) === k
const SHARD_COUNT = Math.max(1, Number(process.env.SHARD_COUNT || '1'));
const SHARD_INDEX = Number(process.env.SHARD_INDEX || '0');

const RETRY_BLOCKED = process.env.RETRY_BLOCKED !== '0';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES !== '0';
console.log(`🧩 Resource blocking: ${BLOCK_RESOURCES ? 'ON' : 'OFF'}`);

const PAGE_ZOOM = Number(process.env.PAGE_ZOOM || '0.05');
const VIEWPORT_W = Number(process.env.VIEWPORT_W || '1400');
const VIEWPORT_H = Number(process.env.VIEWPORT_H || '900');

const NAV_DELAY_MIN = Number(process.env.NAV_DELAY_MIN || '100');
const NAV_DELAY_MAX = Number(process.env.NAV_DELAY_MAX || '500');
const HYDRATE_TIMEOUT = Number(process.env.HYDRATE_TIMEOUT || '10000');
const HYDRATE_SETTLE = Number(process.env.HYDRATE_SETTLE || '500');
const ZOOM_SETTLE_MS = Number(process.env.ZOOM_SETTLE_MS || '1200');
const HEADING_SETTLE_MS = Number(process.env.HEADING_SETTLE_MS || '1500');
const TABLE_VIEW_SETTLE_MS = Number(process.env.TABLE_VIEW_SETTLE_MS || '1000');
const TABLE_WAIT_MS = Number(process.env.TABLE_WAIT_MS || '15000');
const CLICK_EXPAND_SETTLE_MS = Number(process.env.CLICK_EXPAND_SETTLE_MS || '1000');
const SCROLL_WRAPPER_SETTLE_MS = Number(process.env.SCROLL_WRAPPER_SETTLE_MS || '1000');
const RETRY_SCROLL_SETTLE_MS = Number(process.env.RETRY_SCROLL_SETTLE_MS || '2000');
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS || '5000');

const HEADER_START_COL = 9;
const HEADERS = [
    "Price", "Street", "City", "State", "Zipcode", "Final URL", "Agent Details", "Sold Price",
    "Status", "Description", "Full Address", "Price Per Sqft", "Beds", "Baths", "Sqft", "Lot Size",
    "Listed For Sale", "Sold On", "MLS", "Property Type", "Year Built", "HOA",
    "Price History", "Facts & Features", "Page Text (Formatted)"
];
const OVERWRITE_HEADERS = process.env.OVERWRITE_HEADERS === '1';

const MAX_CELL_LEN = 49000;
const safeCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
};

// (reverted to the original list — datagrail/consentjs/pubnub are no longer blocked)
const AD_HOSTS = /doubleclick|googletagmanager|google-analytics|googlesyndication|facebook\.net|facebook\.com|criteo|taboola|adsrvr|tiktok|snapchat|hotjar|fullstory|bing\.com|quantserve|scorecardresearch/i;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// =========================================================
// BROWSER (Chrome only)
// =========================================================
async function launchBrowser() {
    const userDataDir = path.join(os.tmpdir(), `zl-chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        '--enable-javascript',
        '--enable-webgl',
        '--enable-webgl2',
        '--enable-accelerated-2d-canvas',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--enable-canvas-2d-layers',
        '--enable-native-gpu-memory-buffers',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-webrtc',
        '--enable-websockets',
        '--enable-dns-prefetch',
        '--enable-quic',
    ];
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir,
        args,
        ignoreDefaultArgs: ['--disable-gpu'],
    });
    browser.__userDataDir = userDataDir;
    return browser;
}

async function closeBrowser(browser) {
    if (!browser) return;
    try { await browser.close(); } catch (e) {}
    try { if (browser.__userDataDir) fs.rmSync(browser.__userDataDir, { recursive: true, force: true }); } catch (e) {}
}

async function newContext(browser) {
    return typeof browser.createBrowserContext === 'function'
        ? browser.createBrowserContext()
        : browser.createIncognitoBrowserContext();
}

// =========================================================
// GOOGLE SHEETS HELPERS
// =========================================================
async function saveWithRetry(sheet, retries = 4) {
    for (let i = 0; i < retries; i++) {
        try { await sheet.saveUpdatedCells(); return; }
        catch (error) {
            if (i === retries - 1) throw error;
            await delay((2 ** i) * 1000);
        }
    }
}

function safeValue(sheet, row, col) {
    try {
        const v = sheet.getCell(row, col).value;
        return v === null || v === undefined ? "" : String(v);
    } catch (e) { return ""; }
}

function findNextRow(sheet, afterRow, includeSkipped) {
    for (let r = afterRow + 1; r < sheet.rowCount; r++) {
        if (SHARD_COUNT > 1 && (r % SHARD_COUNT) !== SHARD_INDEX) continue;
        const url = safeValue(sheet, r, 0);
        if (!url || !url.includes("zillow.com")) continue;
        const status = safeValue(sheet, r, 17);
        if (isDoneStatus(status)) continue;
        if (!includeSkipped && isSkipStatus(status)) continue;
        return r;
    }
    return -1;
}

// =========================================================
// IN-PAGE: PRICE HISTORY PARSER
// =========================================================
function parseHistoryRowsInPage() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isHistoryTable = (t) => {
        const hs = Array.from(t.querySelectorAll('th')).map(x => clean(x.textContent).toLowerCase());
        return hs.includes('date') && hs.includes('event') && hs.includes('price');
    };

    const table = Array.from(document.querySelectorAll(
        'table[data-c11n-component="Table.Root"], table.c11n_table__root, table'
    )).find(isHistoryTable);
    if (!table) return [];

    const rows = [];
    const tbody = table.querySelector('tbody') || table;
    const dataRows = Array.from(tbody.querySelectorAll('tr'));

    const isDataRow = (tr) =>
        !!tr.querySelector('[data-testid="date-info"]') || !!tr.getAttribute('label');
    const isSourceRow = (tr) =>
        !isDataRow(tr) && !!tr.querySelector('td[colspan]');

    for (let i = 0; i < dataRows.length; i++) {
        const tr = dataRows[i];
        if (!isDataRow(tr)) continue;

        const label = tr.getAttribute('label') || '';
        let lblDate = '', lblEvent = '', lblPrice = '';
        const lm = label.match(/Date:\s*([^,]+),\s*Event:\s*(.+?),\s*Price:\s*(.*)$/i);
        if (lm) {
            lblDate = clean(lm[1]);
            lblEvent = clean(lm[2]);
            lblPrice = clean(lm[3]);
        }

        const dateEl = tr.querySelector('[data-testid="date-info"]');
        const date = clean(dateEl?.textContent) || lblDate;

        const cells = tr.querySelectorAll('td');
        const event = clean(cells[1]?.textContent) || lblEvent;

        let price = '', change = '', ppsf = '';
        const priceCell = tr.querySelector('[data-testid="price-money-cell"]');
        if (priceCell) {
            price = clean(priceCell.querySelector('span > span')?.textContent);
            change = clean(priceCell.querySelector('[data-testid="percent-display"]')?.textContent);
            const lastTxt = clean(priceCell.lastElementChild?.textContent);
            if (/sqft/i.test(lastTxt)) ppsf = lastTxt;
        }

        if (!price && lblPrice) {
            const pm = lblPrice.match(/^(\$[\d,]+)(?:\s*\(([-+]?\d+(?:\.\d+)?%)\))?/);
            if (pm) { price = pm[1]; if (!change && pm[2]) change = pm[2]; }
            else price = lblPrice;
        }
        if (!change && lblPrice) {
            const cm = lblPrice.match(/\(([-+]?\d+(?:\.\d+)?%)\)/);
            if (cm) change = cm[1];
        }

        let source = '';
        for (let j = i + 1; j < dataRows.length; j++) {
            const nxt = dataRows[j];
            if (isDataRow(nxt)) break;
            if (isSourceRow(nxt)) {
                source = clean(nxt.textContent)
                    .replace(/\s*Report\s*a\s+problem\s*$/i, '')
                    .replace(/\s+/g, ' ').trim();
                break;
            }
        }

        if (!date && !event && !price) continue;
        rows.push({ date, event, price, change, ppsf, source });
    }
    return rows;
}

// =========================================================
// MOUNT PRICE HISTORY (zoom + Table view + expanders) THEN LOOP "SHOW MORE"
// =========================================================
const IN_PAGE_HAS_TABLE = () => {
    const tables = document.querySelectorAll('table');
    return Array.from(tables).some(t => {
        const hs = Array.from(t.querySelectorAll('th')).map(x => (x.textContent || '').trim().toLowerCase());
        return hs.includes('date') && hs.includes('event') && hs.includes('price');
    });
};

async function waitForHistoryTable(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (SHUTDOWN_REQUESTED) return false;
        const ok = await page.evaluate(IN_PAGE_HAS_TABLE).catch(() => false);
        if (ok) return true;
        await delay(500);
    }
    return false;
}

async function ensureHistoryMounted(page, tag) {
    // Step 0: expand collapsed sections
    try {
        const n = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll(
                'button[data-c11n-component="ShowHide.Button"], button[aria-expanded="false"]'
            ));
            let clicked = 0;
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (txt.includes('see more') || txt.includes('show more') || txt.includes('view more') || txt === 'more') {
                    try { btn.click(); clicked++; } catch (e) {}
                }
            }
            return clicked;
        });
        if (n > 0) console.log(`   🔽 [${tag}] Expanded ${n} collapsed section(s)`);
    } catch (e) {}
    await delay(CLICK_EXPAND_SETTLE_MS);

    // Step 1: zoom out + scroll to bottom so lazy sections mount
    try {
        await page.evaluate((z) => {
            document.documentElement.style.zoom = String(z);
            if (document.body) document.body.style.zoom = String(z);
            window.scrollTo(0, document.body.scrollHeight);
        }, PAGE_ZOOM);
    } catch (e) {}
    await delay(ZOOM_SETTLE_MS);

    // Step 2: scroll to Price history heading
    await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll('h2,h3'))
            .find(x => /price\s*history/i.test(x.textContent || ''));
        if (h) h.scrollIntoView({ block: 'center', behavior: 'instant' });
    }).catch(() => {});
    await delay(HEADING_SETTLE_MS);

    // Step 3: click "Table view"
    await page.evaluate(() => {
        const tv = Array.from(document.querySelectorAll('button, [role="button"], a'))
            .find(b => /^\s*table\s+view\s*$/i.test((b.textContent || '').trim()));
        if (tv) tv.click();
    }).catch(() => {});
    await delay(TABLE_VIEW_SETTLE_MS);

    // Step 4: is the table there?
    let tableFound = await page.evaluate(IN_PAGE_HAS_TABLE).catch(() => false);

    // Step 5: click heading + scroll wrapper
    if (!tableFound) {
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => /price\s*history/i.test(x.textContent || ''));
            if (h) {
                h.click();
                const parent = h.closest('[role="button"], button, details, summary, [data-testid*="card"]');
                if (parent) try { parent.click(); } catch (e) {}
            }
        }).catch(() => {});
        await delay(CLICK_EXPAND_SETTLE_MS);
        await page.evaluate(() => {
            const tbl = document.querySelector('table');
            if (tbl) { tbl.scrollIntoView({ block: 'center', behavior: 'instant' }); return; }
            const wrap = document.querySelector('[data-c11n-component="Table.Responsive"]');
            if (wrap) wrap.scrollIntoView({ block: 'center', behavior: 'instant' });
        }).catch(() => {});
        await delay(SCROLL_WRAPPER_SETTLE_MS);
    }

    // Step 6: wait for table
    if (!tableFound) tableFound = await waitForHistoryTable(page, TABLE_WAIT_MS);

    // Step 7: second chance
    if (!tableFound && !SHUTDOWN_REQUESTED) {
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll(
                'button[data-c11n-component="ShowHide.Button"], button[aria-expanded="false"]'
            ));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (txt.includes('see more') || txt.includes('show more')) { try { btn.click(); } catch (e) {} }
            }
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => /price\s*history/i.test(x.textContent || ''));
            if (h) h.scrollIntoView({ block: 'center' });
        }).catch(() => {});
        await delay(RETRY_SCROLL_SETTLE_MS);
        tableFound = await waitForHistoryTable(page, RETRY_WAIT_MS);
    }

    if (!tableFound) {
        console.log(`   ❌ [${tag}] History table NOT mounted`);
        return false;
    }
    console.log(`   📊 [${tag}] History table mounted ✅`);

    // Step 8: loop "Show more" inside the history table
    const getRowCount = () => page.evaluate(() => {
        const t = Array.from(document.querySelectorAll('table')).find(t => {
            const hs = Array.from(t.querySelectorAll('th')).map(x => (x.textContent || '').trim().toLowerCase());
            return hs.includes('date') && hs.includes('event') && hs.includes('price');
        });
        if (!t) return -1;
        const tbody = t.querySelector('tbody') || t;
        return Array.from(tbody.querySelectorAll('tr')).filter(tr =>
            tr.querySelector('[data-testid="date-info"]') || tr.getAttribute('label')
        ).length;
    }).catch(() => -1);

    let totalClicked = 0;
    let prevCount = await getRowCount();
    for (let iter = 0; iter < 15; iter++) {
        if (SHUTDOWN_REQUESTED) break;
        const clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('tfoot[data-testid="table-see-more"] button'));
            let n = 0;
            for (const btn of btns) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (/show\s*more|see\s*more|view\s*more/.test(txt)) {
                    try { btn.scrollIntoView({ block: 'center' }); btn.click(); n++; } catch (e) {}
                }
            }
            return n;
        }).catch(() => 0);
        if (clicked === 0) break;
        totalClicked += clicked;

        const waitDeadline = Date.now() + 4000;
        let grew = false;
        while (Date.now() < waitDeadline) {
            if (SHUTDOWN_REQUESTED) break;
            await delay(300 + jitter(0, 200));
            const c = await getRowCount();
            if (c > prevCount) { grew = true; prevCount = c; break; }
        }
        if (!grew) break;
        await delay(jitter(200, 600));
    }
    console.log(`   🔽 [${tag}] Show more: ${totalClicked} click(s), ${prevCount} rows total`);
    return true;
}

// =========================================================
// IN-PAGE: MAIN DATA EXTRACTOR
// =========================================================
function extractMainDataInPage() {
    const out = {
        price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
        agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
        pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
        listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
        hoa: "", priceHistoryText: "", factsFeaturesText: "", pageText: ""
    };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const num = (s) => {
        const str = String(s || '').replace(/,/g, '').trim();
        if (/^[-—–]+$/.test(str)) return '';
        const m = str.match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : '';
    };
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const metaGet = (p) => document.querySelector(`meta[property="${p}"]`)?.content || '';

    out.canonicalUrl = $('meta[property="og:url"]')?.content || $('link[rel="canonical"]')?.href || location.href;
    out.price = num(clean($('[data-testid="price"]')?.textContent));

    const pill = clean($('[data-testid="gallery-status-pill"]')?.textContent);
    const soldMatch = pill.match(/Sold\s+for\s+\$([\d,]+)/i);
    if (soldMatch) out.soldPrice = Number(soldMatch[1].replace(/,/g, ''));
    else if (/sold/i.test(pill) && out.price) out.soldPrice = out.price;

    const h1 = clean($('h1')?.textContent).replace(/\u00A0/g, ' ');
    if (h1) {
        const parts = h1.split(',').map(clean);
        if (parts.length >= 3) {
            out.street = parts[0];
            out.city = parts[1];
            const stZip = parts[2].match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
            if (stZip) { out.state = stZip[1]; out.zipcode = stZip[2]; }
        }
    }

    const factMap = {};
    $$('[data-testid="bed-bath-sqft-fact-container"]').forEach(c => {
        const sp = c.querySelectorAll('span');
        if (sp.length >= 2) factMap[clean(sp[1].textContent).toLowerCase()] = clean(sp[0].textContent);
    });
    if (factMap.beds)  out.beds  = num(factMap.beds)  || factMap.beds;
    if (factMap.baths) out.baths = num(factMap.baths) || factMap.baths;
    if (factMap.sqft)  out.sqft  = num(factMap.sqft)  || factMap.sqft;

    const glance = $('[aria-label="At a glance facts"]');
    if (glance) {
        for (const item of glance.querySelectorAll('[role="listitem"]')) {
            const t = clean(item.textContent);
            if (!t) continue;
            const lotM = t.match(/^([\d.,]+)\s*Acres?\s+Lot$/i);
            if (lotM && !out.lotSize) out.lotSize = `${lotM[1]} Acres`;
            const yearM = t.match(/^Built\s+in\s+(\d{4})$/i);
            if (yearM && !out.yearBuilt) out.yearBuilt = yearM[1];
            if (!out.propertyType && /^(Single Family|Multi Family|Condo|Townhouse|Manufactured|Mobile|Apartment|Land|Vacant)/i.test(t)) out.propertyType = t;
            const ppsfM = t.match(/\$([\d,]+)\s*\/\s*sqft/i);
            if (ppsfM && !out.pricePerSqft) out.pricePerSqft = Number(ppsfM[1].replace(/,/g, ''));
        }
    }

    const fm = {};
    $$('[data-testid="fact-category"] li').forEach(li => {
        const t = clean(li.textContent);
        const i = t.indexOf(': ');
        if (i > 0) { const k = t.slice(0, i); if (!(k in fm)) fm[k] = t.slice(i + 2); }
    });
    if (!out.propertyType && (fm['Home type'] || fm['Property subtype'])) out.propertyType = fm['Home type'] || fm['Property subtype'];
    if (!out.yearBuilt && fm['Year built']) out.yearBuilt = fm['Year built'];
    if (!out.lotSize && fm['Size']) out.lotSize = fm['Size'];
    if (!out.pricePerSqft && fm['Price per square foot']) out.pricePerSqft = num(fm['Price per square foot']);
    if (!out.hoa) {
        if (fm['HOA fee'] || fm['HOA fee frequency']) out.hoa = fm['HOA fee'] || fm['HOA fee frequency'];
        else out.hoa = 'No / None listed';
    }

    const descEl = $('[data-testid="description"] article') || $('[data-testid="description"]');
    if (descEl) out.description = clean(descEl.textContent) || 'N/A';

    const la = $('[data-testid="attribution-LISTING_AGENT"]');
    if (la) {
        const parts = Array.from(la.querySelectorAll('span')).map(x => clean(x.textContent).replace(/,$/, '')).filter(Boolean);
        const broker = clean($('[data-testid="attribution-BROKER"]')?.textContent);
        out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
    }

    const mlsInfo = clean($('[role="contentinfo"][aria-label="MLS information"]')?.textContent);
    if (mlsInfo) {
        let m = mlsInfo.match(/Source:\s*(.+?),\s*MLS#:\s*([A-Za-z0-9-]+)/);
        if (m) out.mls = `${m[2].replace(/Originating.*$/i, '').trim()} - ${clean(m[1])}`;
        else {
            m = mlsInfo.match(/MLS#?:\s*([A-Za-z0-9-]+)\s*(?:Originating\s+MLS:?\s*([A-Za-z .]+))?/i);
            if (m) {
                const id = m[1].replace(/Originating.*$/i, '').trim();
                const src = m[2] ? clean(m[2]) : 'Hive MLS';
                out.mls = `${id} - ${src}`;
            }
        }
    }

    const formatPageText = () => {
        const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','TEMPLATE','BUTTON','SELECT','INPUT','TEXTAREA','HEAD','LINK','META','PATH','IMG','VIDEO','AUDIO','CANVAS','OBJECT','EMBED']);
        const SKIP_IDS = new Set(['pfs-nav-wrapper','page-header-container','sw-container','skip-topnav-target','__PFS_TOPNAV_DATA__','hdp-srp-split-page-frame-nav-styles','with-product-nav-styles','hdp-srp-split-no-search-layout-styles']);
        const SKIP_TESTIDS = new Set(['topnav','back-link','desktop-action-bar','close-lightbox-button']);
        const INLINE = new Set(['A','SPAN','B','STRONG','EM','I','U','SMALL','LABEL','SUP','SUB','ABBR','TIME','MARK','CODE','FONT','BR']);
        const lines = []; let buf = '';
        const flush = (prefix = '') => { const t = clean(buf); buf = ''; if (t) lines.push(prefix + t); };
        const isChrome = (n) => {
            if (n.id && SKIP_IDS.has(n.id)) return true;
            const tid = n.getAttribute && n.getAttribute('data-testid');
            if (tid && SKIP_TESTIDS.has(tid)) return true;
            const cls = (n.className && String(n.className)) || '';
            return /\b(topnav|znav|pfs-nav|hdp-action-bar|layout-action-bar|with-product-nav__product-nav)\b/i.test(cls);
        };
        const walk = (n) => {
            if (n.nodeType === 3) { buf += ' ' + n.nodeValue; return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName.toUpperCase();
            if (SKIP.has(tag)) return;
            if (n.hidden || n.getAttribute('aria-hidden') === 'true') return;
            if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style') || '')) return;
            if (isChrome(n)) return;
            if (/^H[1-6]$/.test(tag)) { flush(); const t = clean(n.textContent); if (t) { lines.push(''); lines.push('## ' + t); } return; }
            if (tag === 'TR') { flush(); const cells = Array.from(n.children).filter(c => /^(TD|TH)$/i.test(c.tagName)).map(c => clean(c.textContent)).filter(Boolean); if (cells.length) lines.push(cells.join(' | ')); return; }
            if (tag === 'BR') { flush(); return; }
            if (tag === 'LI') { flush(); for (const c of n.childNodes) walk(c); flush('- '); return; }
            const inline = INLINE.has(tag);
            if (!inline) flush();
            for (const c of n.childNodes) walk(c);
            if (!inline) flush();
        };
        walk(document.body);
        flush();
        const res = [];
        for (const l of lines) {
            const prev = res[res.length - 1];
            if (l === '' && (prev === '' || prev === undefined)) continue;
            if (l !== '' && l === prev) continue;
            res.push(l);
        }
        const head = [clean(document.title), location.href, '', '----------------------------------------', ''];
        const formatted = head.concat(res).join('\n').trim();
        if (formatted.length < 800) {
            const fb = (document.body.innerText || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            return head.concat(['', fb]).join('\n').trim();
        }
        return formatted;
    };
    try { out.pageText = formatPageText(); } catch (e) { out.pageText = document.body.innerText || ''; }

    out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(', ');

    try {
        const h = Array.from(document.querySelectorAll('h2,h3'))
            .find(x => /^Facts\s*&\s*[Ff]eatures$/i.test(clean(x.textContent)));
        if (h && h.parentElement) {
            const lines = [];
            h.parentElement.querySelectorAll('*').forEach(el => {
                if (/^(P|LI|SPAN|DIV|H[1-6])$/i.test(el.tagName)) {
                    const t = clean(el.textContent);
                    if (t && t.length < 300 && !lines.includes(t)) lines.push(t);
                }
            });
            out.factsFeaturesText = lines.join('\n');
        }
    } catch (e) {}

    // JSON __NEXT_DATA__ (used as fallback source, incl. price history)
    try {
        const nextData = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null');
        const raw = nextData?.props?.pageProps?.componentProps?.gdpClientCache;
        if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            for (const key of Object.keys(parsed)) {
                const prop = parsed[key]?.property;
                if (!prop) continue;
                if (!out.price && prop.price) out.price = prop.price;
                if (!out.soldPrice && prop.lastSoldPrice) out.soldPrice = prop.lastSoldPrice;
                const sd = prop.dateSold || prop.lastSoldDate || prop.soldDate;
                if (sd && !out.soldOn) { const d = new Date(sd); if (!isNaN(d)) out.soldOn = `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; }
                const ld = prop.listedDate || prop.dateListed || prop.listingDate;
                if (ld && !out.listedForSale) { const d = new Date(ld); if (!isNaN(d)) out.listedForSale = `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()} ($${prop.price || '?'})`; }
                const ai = prop.attributionInfo;
                if (ai) {
                    if (!out.mls && (ai.mlsId || ai.mlsName)) out.mls = [ai.mlsId, ai.mlsName].filter(Boolean).join(' - ');
                    if (!out.agentDetails) out.agentDetails = [ai.agentName, ai.brokerName, ai.agentPhoneNumber].filter(Boolean).join(' | ');
                }
                if (Array.isArray(prop.priceHistory) && prop.priceHistory.length > 0 && !out.priceHistoryText) {
                    const fmtDate = (d) => {
                        if (typeof d === 'number') { const x = new Date(d); return `${x.getUTCMonth()+1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; }
                        const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
                        return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(d || '');
                    };
                    out.priceHistoryText = prop.priceHistory.map(h => {
                        const priceTxt = typeof h.price === 'number' ? `$${h.price.toLocaleString('en-US')}` : (h.price || '');
                        const change = (typeof h.priceChangeRate === 'number' && h.priceChangeRate !== 0) ? ` (${(h.priceChangeRate*100).toFixed(1)}%)` : '';
                        const source = h.source ? `Source: ${h.source}` : '';
                        const ppsf = h.pricePerSquareFoot ? `$${Math.round(h.pricePerSquareFoot)}/sqft` : '';
                        return [fmtDate(h.date), h.event, priceTxt + change, ppsf, source].filter(Boolean).join(' | ');
                    }).join('\n');
                    for (const h of prop.priceHistory) {
                        const ev = String(h.event || '').toLowerCase();
                        if (ev.includes('listed') && !out.listedForSale) out.listedForSale = `${fmtDate(h.date)} ($${h.price || '?'})`;
                        if (ev.includes('sold') && !out.soldOn) out.soldOn = fmtDate(h.date);
                    }
                }
                break;
            }
        }
    } catch (e) {}

    if (!out.beds) { const b = metaGet('zillow_fb:beds'); if (b) out.beds = b; }
    if (!out.baths) { const b = metaGet('zillow_fb:baths'); if (b) out.baths = b; }
    if ((!out.description || out.description === 'N/A')) {
        const md = metaGet('og:zillow_fb:description');
        if (md) out.description = md;
    }
    if (!out.street) { const a = metaGet('og:zillow_fb:address'); if (a) out.street = a; }

    return out;
}

// =========================================================
// SCRAPE ONE URL
// =========================================================
async function scrapeOneUrl(browser, url, workerTag) {
    const tag = `${workerTag}:${String(url).slice(-22)}`;
    const ctx = await newContext(browser);
    let page;
    try {
        page = await ctx.newPage();
        await page.setJavaScriptEnabled(true);
        try { await page.setBypassCSP(true); } catch (e) {}
        await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });

        if (BLOCK_RESOURCES) {
            try {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const type = req.resourceType();
                    if (['image', 'stylesheet', 'font', 'media'].includes(type) || AD_HOSTS.test(req.url()))
                        req.abort().catch(() => {});
                    else req.continue().catch(() => {});
                });
            } catch (e) {
                console.warn(`   ⚠️ [${tag}] Interception unavailable (${e.message})`);
            }
        }

        try {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                if (!window.chrome) window.chrome = {};
                if (!window.chrome.runtime) window.chrome.runtime = {};
            });
        } catch (e) {}

        await delay(jitter(NAV_DELAY_MIN, NAV_DELAY_MAX));
        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });

        await page.waitForSelector(
            '[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"]',
            { timeout: HYDRATE_TIMEOUT }
        ).catch(() => {});
        await delay(HYDRATE_SETTLE);

        // ---- Blocked detection (captcha-safe) ----
        const title = await page.title();
        const probe = await page.evaluate(() => ({
            hasNext: !!document.querySelector('script#__NEXT_DATA__'),
            hasPrice: !!document.querySelector('[data-testid="price"]'),
            hasH1: !!document.querySelector('h1'),
            bodyLen: (document.body?.innerText || '').length,
        }));
        const blockedTitle = /pardon our interruption|robot check|access denied|access to this page has been denied|press\s*&\s*hold|unusual traffic|captcha/i.test(title);
        // A real listing page always has __NEXT_DATA__ or a price/h1. Block pages have none.
        const trulyBlocked = blockedTitle || (!probe.hasNext && !probe.hasPrice) || (!probe.hasH1 && probe.bodyLen < 500);

        console.log(`   🔎 [${tag}] probe: next=${probe.hasNext} price=${probe.hasPrice} h1=${probe.hasH1} bodyLen=${probe.bodyLen}`);
        if (trulyBlocked) return { blocked: true, blockedTitle };

        // ---- Mount price history, then extract everything ----
        await ensureHistoryMounted(page, tag);

        const data = await page.evaluate(extractMainDataInPage);
        if (!data.canonicalUrl) data.canonicalUrl = url;

        let domRows = [];
        try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
        if (!domRows.length) {
            await page.evaluate(() => {
                const h = Array.from(document.querySelectorAll('h2,h3'))
                    .find(x => /price\s*history/i.test(x.textContent || ''));
                if (h) h.scrollIntoView({ block: 'center' });
            }).catch(() => {});
            await delay(1500);
            try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
        }

        if (domRows.length) {
            data.priceHistoryText = domRows.map(r => {
                const priceTxt = r.price + (r.change ? ` (${r.change})` : '');
                return [r.date, r.event, priceTxt, r.ppsf, r.source].filter(Boolean).join(' | ');
            }).join('\n');
            for (const r of domRows) {
                const ev = String(r.event || '').toLowerCase();
                if (ev.includes('listed') && !data.listedForSale) data.listedForSale = `${r.date} (${r.price})`;
                if (ev.includes('sold') && !data.soldOn) data.soldOn = r.date;
            }
            if (!data.mls) {
                for (const r of domRows) {
                    const m = String(r.source || '').match(/Source:\s*(.+?)\s*#\s*([A-Za-z0-9-]+)/i);
                    if (m) { data.mls = `${m[2].trim()} - ${m[1].trim()}`; break; }
                }
            }
            console.log(`   📊 [${tag}] DOM history: ${domRows.length} row(s)`);
        } else {
            console.log(`   ⚠️ [${tag}] DOM history empty${data.priceHistoryText ? ' (__NEXT_DATA__ fallback OK)' : ''}`);
        }

        if (!data.description || data.description === 'N/A') {
            try {
                const ldDesc = await page.evaluate(() => {
                    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
                        try {
                            const j = JSON.parse(sc.textContent);
                            if (j && j.description && String(j.description).length > 40) return String(j.description).replace(/\r/g, '').trim();
                        } catch (e) {}
                    }
                    return "";
                });
                data.description = ldDesc || data.description || 'N/A';
            } catch (e) { data.description = data.description || 'N/A'; }
        }

        return { blocked: false, data, domRowsFound: domRows.length };
    } finally {
        if (page) await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log(`🚀 Chrome Stealth Scraper | workers=${CONCURRENCY} | shard=${SHARD_INDEX + 1}/${SHARD_COUNT} | resource-block=${BLOCK_RESOURCES ? 'ON' : 'OFF'}`);

    const setOutput = (hasMore, blocked) => {
        if (process.env.GITHUB_OUTPUT) {
            try { fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`); } catch (e) {}
        }
    };

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    if (sheet.columnCount < REQUIRED_COLS) await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    await sheet.loadCells();
    console.log(`📊 Sheet: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    // Only shard 0 writes headers, to avoid parallel jobs racing on row 1
    if (SHARD_INDEX === 0) {
        try {
            let hd = 0;
            HEADERS.forEach((title, i) => {
                const col = HEADER_START_COL + i;
                if (col >= sheet.columnCount) return;
                const cell = sheet.getCell(0, col);
                if (OVERWRITE_HEADERS || !cell.value) { cell.value = title; try { cell.textFormat = { bold: true }; } catch (e) {} hd++; }
            });
            if (hd) await saveWithRetry(sheet);
        } catch (e) { console.warn(`⚠️ Headings: ${e.message}`); }
    }

    const queue = [];
    const setCell = (r, c, v) => { if (c < sheet.columnCount) sheet.getCell(r, c).value = safeCell(v); };
    const applyEntry = ({ row, status, d }) => {
        setCell(row, 17, status);
        if (!d) return;
        setCell(row, 9,  d.price);
        setCell(row, 10, d.street);
        setCell(row, 11, d.city);
        setCell(row, 12, d.state);
        setCell(row, 13, d.zipcode);
        setCell(row, 14, d.canonicalUrl);
        setCell(row, 15, d.agentDetails);
        setCell(row, 16, d.soldPrice);
        setCell(row, 18, d.description);
        setCell(row, 19, d.fullAddress);
        setCell(row, 20, d.pricePerSqft);
        setCell(row, 21, d.beds);
        setCell(row, 22, d.baths);
        setCell(row, 23, d.sqft);
        setCell(row, 24, d.lotSize);
        setCell(row, 25, d.listedForSale);
        setCell(row, 26, d.soldOn);
        setCell(row, 27, d.mls);
        setCell(row, 28, d.propertyType);
        setCell(row, 29, d.yearBuilt);
        setCell(row, 30, d.hoa);
        setCell(row, 31, d.priceHistoryText);
        setCell(row, 32, d.factsFeaturesText);
        setCell(row, 33, d.pageText);
    };
    let flushChain = Promise.resolve();
    const doFlush = async () => {
        if (!queue.length) return;
        const batch = queue.splice(0, queue.length);
        batch.forEach(applyEntry);
        try {
            await saveWithRetry(sheet);
            console.log(`💾 Saved ${batch.length} row(s)`);
        } catch (e) {
            console.warn(`⚠️ Save failed (${e.message})`);
        }
    };
    const flush = () => (flushChain = flushChain.then(doFlush));

    let claimed = 0, success = 0, blockStreak = 0, errorStreak = 0;
    let totalBlocks = 0, totalErrors = 0, totalWithHistory = 0;
    let cursor = -1;
    let stop = false, blockedExit = false;

    // Synchronous claim: JS is single-threaded, so two workers can never get the same row
    const claimRow = () => {
        const r = findNextRow(sheet, cursor, claimed === 0 && RETRY_BLOCKED);
        if (r !== -1) cursor = r;
        return r;
    };

    async function worker(id) {
        const wtag = `W${id}`;
        let browser = null, used = 0;
        try {
            // Stagger worker start so N browsers don't hit Zillow in the same instant
            await delay((id - 1) * jitter(1500, 3000));

            while (!stop && !SHUTDOWN_REQUESTED) {
                if (Date.now() - startTime >= MAX_RUNTIME_MS) break;
                if (claimed >= MAX_URLS_PER_RUN) break;
                if (errorStreak >= MAX_CONSECUTIVE_ERRORS) { stop = true; break; }

                const rowIndex = claimRow();
                if (rowIndex === -1) break;
                claimed++;
                const url = String(safeValue(sheet, rowIndex, 0));
                const actualRow = rowIndex + 1;
                console.log(`🕵️ [${wtag}] Row ${actualRow} (${claimed}/${MAX_URLS_PER_RUN}): ${url}`);

                let recycle = false;
                try {
                    if (!browser || used >= RECYCLE_BROWSER_EVERY) {
                        await closeBrowser(browser);
                        browser = await launchBrowser();
                        used = 0;
                    }
                    used++;

                    const result = await scrapeOneUrl(browser, url, wtag);

                    if (result.blocked) {
                        console.log(`❌ [${wtag}] BLOCKED on Row ${actualRow}`);
                        queue.push({ row: rowIndex, status: result.blockedTitle ? "❌ BLOCKED (skipped)" : "🚫 No data - blocked? (skipped)" });
                        blockStreak++; errorStreak = 0; totalBlocks++;
                        recycle = true;
                        if (blockStreak >= MAX_CONSECUTIVE_BLOCK_STREAKS) { stop = true; blockedExit = true; }
                    } else {
                        const d = result.data;
                        if (d.priceHistoryText) totalWithHistory++;

                        if (!(d.price || d.fullAddress || d.description)) {
                            console.log(`⚠️ [${wtag}] Empty parse Row ${actualRow}`);
                            queue.push({ row: rowIndex, status: "⚠️ Empty parse (skipped)" });
                            errorStreak++; totalErrors++;
                        } else {
                            queue.push({ row: rowIndex, status: "✅ Done", d });
                            success++; blockStreak = 0; errorStreak = 0;
                            const histCount = d.priceHistoryText ? d.priceHistoryText.split('\n').length : 0;
                            console.log(`✔️ [${wtag}] ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${histCount} | 🏷️ ${d.mls || '—'}`);
                        }
                    }
                } catch (e) {
                    console.error(`🛑 [${wtag}] Error Row ${actualRow}: ${e.message}`);
                    queue.push({ row: rowIndex, status: "🛑 Error: " + String(e.message).slice(0, 100) });
                    errorStreak++; totalErrors++;
                    recycle = true;
                }

                if (recycle) { await closeBrowser(browser); browser = null; }
                if (queue.length >= FLUSH_EVERY) flush();
            }
        } finally {
            await closeBrowser(browser);
        }
    }

    console.log(`🚦 Starting ${CONCURRENCY} Chrome worker(s)`);
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
    await flush();

    console.log(`\n📊 ─── RUN TOTALS ───`);
    console.log(`✅ Success: ${success} | 🚫 Blocked: ${totalBlocks} | 🛑 Errors: ${totalErrors}`);
    console.log(`📊 Rows with price history: ${totalWithHistory}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    if (SHUTDOWN_REQUESTED) {
        console.log(`🛑 Run was cancelled — has_more=false blocked=false so workflow stops.`);
        setOutput(false, false);
        return;
    }

    if (blockedExit) {
        console.log(`🛑 ${MAX_CONSECUTIVE_BLOCK_STREAKS} consecutive blocks — exiting.`);
        setOutput(true, true);
        return;
    }

    const remaining = RETRY_BLOCKED ? findNextRow(sheet, cursor, true) : findNextRow(sheet, -1, false);
    const hasMore = remaining !== -1;
    setOutput(hasMore, false);
    console.log(hasMore ? `🔄 More rows — resume at row ${remaining + 1}.` : "🎉 Sheet fully processed!");
}

runScraper()
    .then(() => {
        console.log('👋 Script finished.');
        process.exit(0);
    })
    .catch(err => {
        console.error("💥 Fatal:", err);
        process.exit(SHUTDOWN_REQUESTED ? 0 : 1);
    });
