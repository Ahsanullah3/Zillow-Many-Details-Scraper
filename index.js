// =========================================================
// ZILLOW SCRAPER — COMPLETE PRODUCTION SCRIPT
// Multi-browser (Chrome + Edge + Firefox) | 34-col sheet output
// Price history: looped "Show more" + hardened parser + GraphQL fallback
// Graceful cancel on SIGTERM/SIGINT (GitHub Actions Cancel button)
// =========================================================

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer');
const puppeteerCore = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

// =========================================================
// GRACEFUL CANCEL — fires on SIGTERM (Actions cancel) / SIGINT (Ctrl+C)
// =========================================================
let SHUTDOWN_REQUESTED = false;
const shutdown = (signal) => {
    if (SHUTDOWN_REQUESTED) return;
    SHUTDOWN_REQUESTED = true;
    console.log(`\n🛑 Received ${signal} — shutting down cleanly...`);
    // Hard-exit fallback after 8s in case a browser launch/flush hangs
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
const CONCURRENCY = Number(process.env.CONCURRENCY || '3');
const MAX_URLS_PER_RUN = Number(process.env.MAX_URLS_PER_RUN || '150');
const FLUSH_EVERY = Number(process.env.FLUSH_EVERY || '3');
const REQUIRED_COLS = 34;
const MAX_CONSECUTIVE_BLOCK_STREAKS = Number(process.env.MAX_BLOCK_STREAK || '6');
const MAX_CONSECUTIVE_ERRORS = 6;
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 60 * 60 * 1000);
const RECYCLE_BROWSER_EVERY = Number(process.env.RECYCLE_BROWSER_EVERY || '10');

const RETRY_BLOCKED = process.env.RETRY_BLOCKED !== '0';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES !== '0';
console.log(`🧩 Resource blocking: ${BLOCK_RESOURCES ? 'ON' : 'OFF'}`);

const PAGE_ZOOM = Number(process.env.PAGE_ZOOM || '1');
const VIEWPORT_W = Number(process.env.VIEWPORT_W || '1400');
const VIEWPORT_H = Number(process.env.VIEWPORT_H || '900');

const NAV_DELAY_MIN = Number(process.env.NAV_DELAY_MIN || '100');
const NAV_DELAY_MAX = Number(process.env.NAV_DELAY_MAX || '500');
const HYDRATE_TIMEOUT = Number(process.env.HYDRATE_TIMEOUT || '12000');
const HYDRATE_SETTLE = Number(process.env.HYDRATE_SETTLE || '600');

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

const AD_HOSTS = /doubleclick|googletagmanager|google-analytics|googlesyndication|facebook\.net|facebook\.com|criteo|taboola|adsrvr|tiktok|snapchat|hotjar|fullstory|bing\.com|quantserve|scorecardresearch|datagrail|consentjs|pubnub/i;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// =========================================================
// BROWSER LAUNCHERS (Chrome / Edge / Firefox)
// =========================================================
function findEdgeExecutable() {
    const candidates = [
        process.env.EDGE_PATH,
        '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
        '/opt/microsoft/msedge/msedge',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
    return null;
}

function findFirefoxExecutable() {
    const candidates = [
        process.env.FIREFOX_PATH,
        '/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox',
        '/opt/firefox/firefox',
        '/Applications/Firefox.app/Contents/MacOS/firefox',
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    ].filter(Boolean);
    for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
    return null;
}

const COMMON_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
    '--enable-javascript',
    '--enable-webgl',
];

async function launchChrome() {
    const userDataDir = path.join(os.tmpdir(), `zl-chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir,
        args: COMMON_ARGS,
        ignoreDefaultArgs: ['--disable-gpu'],
    });
    browser.__userDataDir = userDataDir;
    browser.__engine = 'chrome';
    return browser;
}

async function launchEdge() {
    const edgePath = findEdgeExecutable();
    if (!edgePath) { console.warn('⚠️ Edge not found — skipping'); return null; }
    const userDataDir = path.join(os.tmpdir(), `zl-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
        const browser = await puppeteerCore.launch({
            executablePath: edgePath,
            headless: "new",
            userDataDir,
            args: COMMON_ARGS,
            ignoreDefaultArgs: ['--disable-gpu'],
        });
        browser.__userDataDir = userDataDir;
        browser.__engine = 'edge';
        return browser;
    } catch (e) { console.warn(`⚠️ Edge failed: ${e.message}`); return null; }
}

async function launchFirefox() {
    const firefoxPath = findFirefoxExecutable();
    if (!firefoxPath) { console.warn('⚠️ Firefox not found — skipping'); return null; }
    const userDataDir = path.join(os.tmpdir(), `zl-ff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
        const browser = await puppeteerCore.launch({
            browser: 'firefox',
            executablePath: firefoxPath,
            headless: "new",
            userDataDir,
            args: [`--width=${VIEWPORT_W}`, `--height=${VIEWPORT_H}`],
            extraPrefsFirefox: {
                'dom.webdriver.enabled': false,
                'useAutomationExtension': false,
            },
        });
        browser.__userDataDir = userDataDir;
        browser.__engine = 'firefox';
        return browser;
    } catch (e) { console.warn(`⚠️ Firefox failed: ${e.message}`); return null; }
}

async function launchBrowserFor(engine) {
    if (engine === 'chrome')  return launchChrome();
    if (engine === 'edge')    return launchEdge();
    if (engine === 'firefox') return launchFirefox();
    throw new Error(`Unknown engine: ${engine}`);
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
// GOOGLE SHEETS RETRY
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
        const url = safeValue(sheet, r, 0);
        if (!url || !url.includes("zillow.com")) continue;
        const status = safeValue(sheet, r, 17);
        if (isDoneStatus(status)) continue;
        if (!includeSkipped && isSkipStatus(status)) continue;
        return r;
    }
    return -1;
}

const extractZpid = (u) => { const m = String(u).match(/(\d+)_zpid/); return m ? m[1] : null; };

// =========================================================
// IN-PAGE: PRICE HISTORY PARSER (label-first, span-merge)
// =========================================================
function parseHistoryRowsInPage() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isHistoryTable = (t) => {
        const hs = Array.from(t.querySelectorAll('th'))
            .map(x => clean(x.textContent).toLowerCase());
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

        // PRIMARY: label attribute
        const label = tr.getAttribute('label') || '';
        let lblDate = '', lblEvent = '', lblPrice = '';
        const lm = label.match(/Date:\s*([^,]+),\s*Event:\s*(.+?),\s*Price:\s*(.*)$/i);
        if (lm) {
            lblDate = clean(lm[1]);
            lblEvent = clean(lm[2]);
            lblPrice = clean(lm[3]);
        }

        // SECONDARY: child spans
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

        // Source row = next non-data row
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
// MOUNT PRICE HISTORY + LOOP CLICK "SHOW MORE"
// =========================================================
async function ensureHistoryMounted(page, tag) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await delay(1200);

    await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll('h2,h3'))
            .find(x => /price\s*history/i.test(x.textContent || ''));
        if (h) h.scrollIntoView({ block: 'center', behavior: 'instant' });
    }).catch(() => {});
    await delay(1500);

    const getRowCount = () => page.evaluate(() => {
        const t = Array.from(document.querySelectorAll('table')).find(t => {
            const hs = Array.from(t.querySelectorAll('th'))
                .map(x => (x.textContent || '').trim().toLowerCase());
            return hs.includes('date') && hs.includes('event') && hs.includes('price');
        });
        if (!t) return -1;
        const tbody = t.querySelector('tbody') || t;
        return Array.from(tbody.querySelectorAll('tr')).filter(tr =>
            tr.querySelector('[data-testid="date-info"]') || tr.getAttribute('label')
        ).length;
    }).catch(() => -1);

    let mounted = false;
    const mountDeadline = Date.now() + 12000;
    while (Date.now() < mountDeadline) {
        if (SHUTDOWN_REQUESTED) return 0;
        const c = await getRowCount();
        if (c >= 0) { mounted = true; break; }
        await delay(500);
    }
    if (!mounted) { console.log(`   ❌ [${tag}] History table NOT mounted after 12s`); return 0; }

    let totalClicked = 0;
    let prevCount = await getRowCount();
    const maxIter = 15;

    for (let iter = 0; iter < maxIter; iter++) {
        if (SHUTDOWN_REQUESTED) break;

        const clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll(
                'tfoot[data-testid="table-see-more"] button'
            ));
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
            await delay(300);
            const c = await getRowCount();
            if (c > prevCount) { grew = true; prevCount = c; break; }
        }
        if (!grew) break;
    }

    console.log(`   🔽 [${tag}] Show more: ${totalClicked} click(s), ${prevCount} rows total`);
    return totalClicked;
}

// =========================================================
// GRAPHQL FALLBACK
// =========================================================
async function fetchPriceHistoryFromGraphQL(page, zpid) {
    if (!zpid) return null;
    try {
        return await page.evaluate(async (zpidNum) => {
            const query = `query GetPriceHistory($zpid: ID!) {
                property(zpid: $zpid) {
                    priceHistory { date event price priceChangeRate pricePerSquareFoot source }
                }
            }`;
            try {
                const resp = await fetch('https://www.zillow.com/graphql/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'client-id': 'PricingTable' },
                    body: JSON.stringify({
                        operationName: 'GetPriceHistory',
                        query, variables: { zpid: zpidNum },
                    }),
                    credentials: 'include',
                });
                if (!resp.ok) return { error: `HTTP ${resp.status}` };
                return await resp.json();
            } catch (e) { return { error: e.message }; }
        }, String(zpid));
    } catch (e) { return { error: e.message }; }
}

// =========================================================
// IN-PAGE: MAIN DATA EXTRACTOR (all 34 fields)
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

    // Sold price
    const pill = clean($('[data-testid="gallery-status-pill"]')?.textContent);
    const soldMatch = pill.match(/Sold\s+for\s+\$([\d,]+)/i);
    if (soldMatch) out.soldPrice = Number(soldMatch[1].replace(/,/g, ''));
    else if (/sold/i.test(pill) && out.price) out.soldPrice = out.price;

    // Address from h1
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

    // Beds/baths/sqft
    const factMap = {};
    $$('[data-testid="bed-bath-sqft-fact-container"]').forEach(c => {
        const sp = c.querySelectorAll('span');
        if (sp.length >= 2) factMap[clean(sp[1].textContent).toLowerCase()] = clean(sp[0].textContent);
    });
    if (factMap.beds)  out.beds  = num(factMap.beds)  || factMap.beds;
    if (factMap.baths) out.baths = num(factMap.baths) || factMap.baths;
    if (factMap.sqft)  out.sqft  = num(factMap.sqft)  || factMap.sqft;

    // At-a-glance
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

    // Facts & features fact-category
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

    // Description
    const descEl = $('[data-testid="description"] article') || $('[data-testid="description"]');
    if (descEl) out.description = clean(descEl.textContent) || 'N/A';

    // Agent
    const la = $('[data-testid="attribution-LISTING_AGENT"]');
    if (la) {
        const parts = Array.from(la.querySelectorAll('span')).map(x => clean(x.textContent).replace(/,$/, '')).filter(Boolean);
        const broker = clean($('[data-testid="attribution-BROKER"]')?.textContent);
        out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
    }

    // MLS
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

    // Page text (formatted)
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

    // Facts & Features section
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

    // JSON __NEXT_DATA__ (if present — for-sale pages)
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

    // Meta fallback for sparse pages
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
// SCRAPE ONE URL (3-layer price-history fallback)
// =========================================================
async function scrapeOneUrl(browser, url) {
    const tag = `${browser.__engine || '?'}:${String(url).slice(-22)}`;
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
        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 });

        await page.waitForSelector(
            '[data-testid="price"], [data-testid="description"], h1, h2',
            { timeout: HYDRATE_TIMEOUT }
        ).catch(() => {});
        await delay(HYDRATE_SETTLE);

        // ---- Content-aware blocked detection ----
        const title = await page.title();
        const probe = await page.evaluate(() => ({
            hasNext: !!document.querySelector('script#__NEXT_DATA__'),
            hasPrice: !!document.querySelector('[data-testid="price"]'),
            hasH1: !!document.querySelector('h1'),
            hasHistoryHeading: Array.from(document.querySelectorAll('h2,h3'))
                .some(h => /price\s*history/i.test(h.textContent || '')),
            hasAnyTable: !!document.querySelector('table'),
            bodyLen: (document.body?.innerText || '').length,
        }));
        const blockedTitle = /pardon our interruption|robot check|access denied|unusual traffic/i.test(title);
        const trulyBlocked = blockedTitle ||
            (!probe.hasNext && !probe.hasPrice && !probe.hasH1 &&
             !probe.hasHistoryHeading && !probe.hasAnyTable && probe.bodyLen < 500);

        console.log(`   🔎 [${tag}] probe: next=${probe.hasNext} price=${probe.hasPrice} h1=${probe.hasH1} hist=${probe.hasHistoryHeading} bodyLen=${probe.bodyLen}`);

        if (trulyBlocked) return { blocked: true, blockedTitle };

        // ---- Main data ----
        const data = await page.evaluate(extractMainDataInPage);
        if (!data.canonicalUrl) data.canonicalUrl = url;

        // ===== PRICE HISTORY — 3-layer =====
        await ensureHistoryMounted(page, tag);

        let domRows = [];
        const histDeadline = Date.now() + 10000;
        while (Date.now() < histDeadline && !SHUTDOWN_REQUESTED) {
            try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
            if (domRows.length > 0) break;
            await page.evaluate(() => {
                const h = Array.from(document.querySelectorAll('h2,h3'))
                    .find(x => /price\s*history/i.test(x.textContent || ''));
                if (h) h.scrollIntoView({ block: 'center' });
                const btn = document.querySelector('tfoot[data-testid="table-see-more"] button');
                if (btn) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    if (/show\s*more/.test(txt)) try { btn.click(); } catch (e) {}
                }
            }).catch(() => {});
            await delay(1000);
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
        }

        // Layer 3: GraphQL fallback
        if (!data.priceHistoryText && !SHUTDOWN_REQUESTED) {
            const zpid = extractZpid(url);
            if (zpid) {
                console.log(`   🔄 [${tag}] DOM empty — GraphQL zpid ${zpid}`);
                const apiResult = await fetchPriceHistoryFromGraphQL(page, zpid);
                const history = apiResult?.data?.property?.priceHistory;
                if (Array.isArray(history) && history.length > 0) {
                    const fmtDate = (d) => {
                        if (typeof d === 'number') { const x = new Date(d); return `${x.getUTCMonth()+1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; }
                        const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
                        return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(d || '');
                    };
                    data.priceHistoryText = history.map(h => {
                        const priceTxt = typeof h.price === 'number' ? `$${h.price.toLocaleString('en-US')}` : (h.price || '');
                        const change = (typeof h.priceChangeRate === 'number' && h.priceChangeRate !== 0) ? ` (${(h.priceChangeRate*100).toFixed(1)}%)` : '';
                        const source = h.source ? `Source: ${h.source}` : '';
                        const ppsf = h.pricePerSquareFoot ? `$${Math.round(h.pricePerSquareFoot)}/sqft` : '';
                        return [fmtDate(h.date), h.event, priceTxt + change, ppsf, source].filter(Boolean).join(' | ');
                    }).join('\n');
                    for (const h of history) {
                        const ev = String(h.event || '').toLowerCase();
                        if (ev.includes('listed') && !data.listedForSale) data.listedForSale = `${fmtDate(h.date)} ($${h.price || '?'})`;
                        if (ev.includes('sold') && !data.soldOn) data.soldOn = fmtDate(h.date);
                    }
                    console.log(`   ✅ [${tag}] GraphQL history: ${history.length} row(s)`);
                } else {
                    console.log(`   ⚠️ [${tag}] GraphQL also empty: ${JSON.stringify(apiResult).slice(0, 150)}`);
                }
            }
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
                if (ldDesc) data.description = ldDesc;
                else data.description = data.description || 'N/A';
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
    console.log(`🚀 Multi-browser Scraper (Chrome+Edge+Firefox) | concurrency=${CONCURRENCY} | resource-block=${BLOCK_RESOURCES ? 'ON' : 'OFF'}`);

    const setOutput = (hasMore, blocked) => {
        if (process.env.GITHUB_OUTPUT) {
            try {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`);
            } catch (e) {}
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
    let totalBlocks = 0, totalErrors = 0;
    let totalWithHistory = 0;
    let cursor = -1;
    let stop = false, blockedExit = false;

    const claimRow = () => {
        const r = findNextRow(sheet, cursor, claimed === 0 && RETRY_BLOCKED);
        if (r !== -1) cursor = r;
        return r;
    };

    async function laneWorker(engine, id) {
        let browser = null, used = 0;
        try {
            while (!stop && !SHUTDOWN_REQUESTED) {
                if (Date.now() - startTime >= MAX_RUNTIME_MS) break;
                if (claimed >= MAX_URLS_PER_RUN) break;
                if (errorStreak >= MAX_CONSECUTIVE_ERRORS) { stop = true; break; }

                const rowIndex = claimRow();
                if (rowIndex === -1) break;
                claimed++;
                const url = String(safeValue(sheet, rowIndex, 0));
                const actualRow = rowIndex + 1;
                console.log(`🕵️ [${engine}${id}] Row ${actualRow} (${claimed}/${MAX_URLS_PER_RUN}): ${url}`);

                let recycle = false;
                try {
                    if (!browser || used >= RECYCLE_BROWSER_EVERY) {
                        await closeBrowser(browser);
                        browser = await launchBrowserFor(engine);
                        used = 0;
                        if (!browser) {
                            console.warn(`⚠️ [${engine}${id}] Browser unavailable — stopping lane`);
                            return;
                        }
                    }
                    used++;

                    const result = await scrapeOneUrl(browser, url);

                    if (result.blocked) {
                        console.log(`❌ [${engine}${id}] BLOCKED on Row ${actualRow}`);
                        queue.push({ row: rowIndex, status: result.blockedTitle ? "❌ BLOCKED (skipped)" : "🚫 No data - blocked? (skipped)" });
                        blockStreak++; errorStreak = 0; totalBlocks++;
                        recycle = true;
                        if (blockStreak >= MAX_CONSECUTIVE_BLOCK_STREAKS) { stop = true; blockedExit = true; }
                    } else {
                        const d = result.data;
                        if (d.priceHistoryText) totalWithHistory++;

                        if (!(d.price || d.fullAddress || d.description)) {
                            console.log(`⚠️ [${engine}${id}] Empty parse Row ${actualRow}`);
                            queue.push({ row: rowIndex, status: "⚠️ Empty parse (skipped)" });
                            errorStreak++; totalErrors++;
                        } else {
                            queue.push({ row: rowIndex, status: "✅ Done", d });
                            success++; blockStreak = 0; errorStreak = 0;
                            const histCount = d.priceHistoryText ? d.priceHistoryText.split('\n').length : 0;
                            console.log(`✔️ [${engine}${id}] ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${histCount} | 🏷️ ${d.mls || '—'}`);
                        }
                    }
                } catch (e) {
                    console.error(`🛑 [${engine}${id}] Error Row ${actualRow}: ${e.message}`);
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

    // 3 lanes: Chrome, Edge, Firefox
    const lanes = [
        { engine: 'chrome',  id: 1 },
        { engine: 'edge',    id: 1 },
        { engine: 'firefox', id: 1 },
    ];

    console.log(`🚦 Starting ${lanes.length} lanes: ${lanes.map(l => l.engine).join(', ')}`);
    await Promise.all(lanes.map(l => laneWorker(l.engine, l.id)));
    await flush();

    console.log(`\n📊 ─── RUN TOTALS ───`);
    console.log(`✅ Success: ${success} | 🚫 Blocked: ${totalBlocks} | 🛑 Errors: ${totalErrors}`);
    console.log(`📊 Rows with price history: ${totalWithHistory}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    // ---- CANCELLED: do NOT set has_more, do NOT trigger next batch ----
    if (SHUTDOWN_REQUESTED) {
        console.log(`🛑 Run was cancelled — writing has_more=false blocked=false so workflow stops.`);
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
        // Always exit 0 so Actions marks the job success (even on cancel)
        console.log('👋 Script finished.');
        process.exit(0);
    })
    .catch(err => {
        console.error("💥 Fatal:", err);
        process.exit(SHUTDOWN_REQUESTED ? 0 : 1);
    });
