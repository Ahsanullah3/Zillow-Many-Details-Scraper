
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG
// =========================================================
const CONCURRENCY = Number(process.env.CONCURRENCY || '5');
const MAX_URLS_PER_RUN = Number(process.env.MAX_URLS_PER_RUN || '150');
const FLUSH_EVERY = 5;
const REQUIRED_COLS = 34;
const MAX_CONSECUTIVE_BLOCK_STREAKS = Number(process.env.MAX_BLOCK_STREAK || '6');
const MAX_CONSECUTIVE_ERRORS = 6;
const MAX_RUNTIME_MS = 60 * 60 * 1000;
const RECYCLE_BROWSER_EVERY = 10;

const RETRY_BLOCKED = process.env.RETRY_BLOCKED !== '0';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

// ---- BLOCK_RESOURCES: 1 = block heavy assets (default), 0 = load everything
const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES !== '0';
console.log(`🧩 Resource blocking: ${BLOCK_RESOURCES ? 'ON (images/css/fonts/media/ads blocked)' : 'OFF (load everything)'}`);

const PAGE_ZOOM = Number(process.env.PAGE_ZOOM || '0.05');
const VIEWPORT_W = Number(process.env.VIEWPORT_W || '1400');
const VIEWPORT_H = Number(process.env.VIEWPORT_H || '900');

const NAV_DELAY_MIN = Number(process.env.NAV_DELAY_MIN || '100');
const NAV_DELAY_MAX = Number(process.env.NAV_DELAY_MAX || '500');
const HYDRATE_TIMEOUT = Number(process.env.HYDRATE_TIMEOUT || '8000');
const HYDRATE_SETTLE = Number(process.env.HYDRATE_SETTLE || '400');
const ZOOM_SETTLE_MS = Number(process.env.ZOOM_SETTLE_MS || '1200');
const TABLE_WAIT_MS = Number(process.env.TABLE_WAIT_MS || '15000');
const CLICK_EXPAND_SETTLE_MS = Number(process.env.CLICK_EXPAND_SETTLE_MS || '1000');
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS || '5000');

const HEADER_START_COL = 9;
const HEADERS = [
    "Price", "Street", "City", "State", "Zipcode", "Final URL", "Agent Details", "Sold Price",
    "Status", "Description", "Full Address", "Price Per Sqft", "Beds", "Baths", "Sqft", "Lot Size",
    "Listed For Sale", "Sold On", "MLS", "Property Type", "Year Built", "HOA",
    "Price History", "Facts & Features", "Page Text (Formatted)"
];
const OVERWRITE_HEADERS = process.env.OVERWRITE_HEADERS === '1';

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

const MAX_CELL_LEN = 49000;
const safeCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
};

const AD_HOSTS = /doubleclick|googletagmanager|google-analytics|googlesyndication|facebook\.net|facebook\.com|criteo|taboola|adsrvr|tiktok|snapchat|hotjar|fullstory|bing\.com|quantserve|scorecardresearch/i;

// =========================================================
// BROWSER LAUNCH — all features enabled
// =========================================================
async function launchBrowser() {
    const userDataDir = path.join(os.tmpdir(), `zillow-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        // ---- ENABLE EVERYTHING ----
        '--enable-javascript',
        '--enable-webgl',
        '--enable-webgl2',
        '--enable-accelerated-2d-canvas',
        '--enable-accelerated-video-decode',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--enable-canvas-2d-layers',
        '--enable-native-gpu-memory-buffers',
        '--enable-features=CanvasOopRasterization',
        // Media / DRM
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=MediaSessionService',
        // WebRTC / WebSockets
        '--enable-webrtc',
        '--enable-websockets',
        // DNS / networking
        '--enable-dns-prefetch',
        '--enable-quic',
        // Modern JS features
        '--js-flags=--harmony',
        // Form/Storage
        '--enable-features=StorageBuckets',
        '--enable-features=FileSystemAccessAPI',
    ];
    // NOTE: removed --disable-gpu (was blocking WebGL) so hardware rendering
    //       flags above take effect and canvas fingerprint looks real.
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir,
        args,
        ignoreDefaultArgs: ['--disable-gpu'],  // ensure GPU isn't disabled
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
// GOOGLE API RETRY
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

// =========================================================
// SAFE CELL ACCESS
// =========================================================
function safeValue(sheet, row, col) {
    try {
        const v = sheet.getCell(row, col).value;
        return v === null || v === undefined ? "" : String(v);
    } catch (e) {
        return "";
    }
}

// =========================================================
// FIND NEXT ROW
// =========================================================
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

const urlKey = (u) => String(u).trim().split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();

// =========================================================
// PRICE HISTORY PARSER
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
    for (const tr of table.querySelectorAll('tr')) {
        const dateEl = tr.querySelector('[data-testid="date-info"]');
        const label = tr.getAttribute('label') || '';
        if (!dateEl && !label) continue;
        const lm = label.match(/Date:\s*([^,]+),\s*Event:\s*(.+?),\s*Price:\s*(.*)$/i);
        const cells = tr.querySelectorAll('td[data-c11n-component="Table.Cell"], td');
        const date = clean(dateEl?.textContent) || (lm ? clean(lm[1]) : '');
        const event = clean(cells[1]?.textContent) || (lm ? clean(lm[2]) : '');
        let price = '', change = '', ppsf = '';
        const priceCell = tr.querySelector('[data-testid="price-money-cell"]');
        if (priceCell) {
            price = clean(priceCell.querySelector('span > span')?.textContent);
            change = clean(priceCell.querySelector('[data-testid="percent-display"]')?.textContent);
            const lastTxt = clean(priceCell.lastElementChild?.textContent);
            if (/sqft/i.test(lastTxt)) ppsf = lastTxt;
        }
        if (!price && lm) price = clean(lm[3]).replace(/\s*\(.*\)\s*$/, '');
        let source = '';
        const next = tr.nextElementSibling;
        if (next && !next.querySelector('[data-testid="date-info"]') && !next.hasAttribute('label')) {
            source = clean(next.textContent).replace(/\s*Report\s+a\s+problem\s*$/i, '');
        }
        rows.push({ date, event, price, change, ppsf, source });
    }
    return rows;
}

// =========================================================
// FALLBACK PARSER
// =========================================================
function fallbackHistoryParse() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const rows = [];

    document.querySelectorAll('[data-testid="date-info"]').forEach((dateEl) => {
        const tr = dateEl.closest('tr');
        if (!tr) return;
        const cells = tr.querySelectorAll('td');
        const priceCell = tr.querySelector('[data-testid="price-money-cell"]');
        let price = '', change = '';
        if (priceCell) {
            price = clean(priceCell.querySelector('span > span')?.textContent);
            change = clean(priceCell.querySelector('[data-testid="percent-display"]')?.textContent);
        }
        let source = '';
        const next = tr.nextElementSibling;
        if (next && !next.querySelector('[data-testid="date-info"]') && !next.hasAttribute('label')) {
            source = clean(next.textContent).replace(/\s*Report\s+a\s+problem\s*$/i, '');
        }
        rows.push({
            date: clean(dateEl.textContent),
            event: clean(cells[1]?.textContent),
            price,
            change,
            ppsf: '',
            source,
        });
    });

    if (!rows.length) {
        document.querySelectorAll('table').forEach((tbl) => {
            const headers = Array.from(tbl.querySelectorAll('th')).map((x) => clean(x.textContent).toLowerCase());
            if (!(headers.includes('date') && headers.includes('event') && headers.includes('price'))) return;
            tbl.querySelectorAll('tbody tr').forEach((tr) => {
                const cells = Array.from(tr.querySelectorAll('td')).map((c) => clean(c.textContent));
                if (cells.length < 3) return;
                rows.push({
                    date: cells[0],
                    event: cells[1],
                    price: cells[2].replace(/\s*\(.*\)\s*$/, ''),
                    change: (cells[2].match(/\(([^)]+)\)/) || [])[1] || '',
                    ppsf: '',
                    source: '',
                });
            });
        });
    }

    return rows;
}

// =========================================================
// HARDENED MOUNT (with See More click)
// =========================================================
async function ensureHistoryMounted(page, tag) {
    // Click only Zillow's explicit Show more / See more control.
    const clickShowMore = async () => {
        try {
            return await page.evaluate(() => {
                const labels = Array.from(document.querySelectorAll(
                    'span[data-c11n-component="TextButton.Label"]'
                ));
                const buttons = [...new Set(labels.map(el => el.closest('button') || el))];
                let clicked = 0;
                for (const btn of buttons) {
                    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    if (text.includes('show more') || text.includes('see more')) {
                        try { btn.click(); clicked++; } catch (e) {}
                    }
                }
                return clicked;
            });
        } catch (e) {
            return 0;
        }
    };

    const clickedCount = await clickShowMore();
    if (clickedCount) {
        console.log(`   🔽 [${tag}] Clicked ${clickedCount} Show more button(s)`);
    }
    await delay(CLICK_EXPAND_SETTLE_MS);

    // Keep the existing zoom and bottom-page scroll; no heading/table-view clicks
    // and no heading or table-wrapper scrolling.
    try {
        await page.evaluate((z) => {
            document.documentElement.style.zoom = String(z);
            if (document.body) document.body.style.zoom = String(z);
            window.scrollTo(0, document.body.scrollHeight);
        }, PAGE_ZOOM);
    } catch (e) {}
    await delay(ZOOM_SETTLE_MS);

    const tableExists = () => page.evaluate(() => {
        return Array.from(document.querySelectorAll('table')).some(table => {
            const headers = Array.from(table.querySelectorAll('th'))
                .map(cell => (cell.textContent || '').trim().toLowerCase());
            return headers.includes('date') && headers.includes('event') && headers.includes('price');
        });
    }).catch(() => false);

    let tableFound = await tableExists();
    if (!tableFound) {
        try {
            await page.waitForFunction(() => {
                return Array.from(document.querySelectorAll('table')).some(table => {
                    const headers = Array.from(table.querySelectorAll('th'))
                        .map(cell => (cell.textContent || '').trim().toLowerCase());
                    return headers.includes('date') && headers.includes('event') && headers.includes('price');
                });
            }, { timeout: TABLE_WAIT_MS });
            tableFound = true;
        } catch (e) {}
    }

    // One retry of the explicit Show more control only.
    if (!tableFound) {
        const retryClicked = await clickShowMore();
        if (retryClicked) {
            console.log(`   🔁 [${tag}] Retried Show more (${retryClicked} button(s))`);
        }
        await delay(CLICK_EXPAND_SETTLE_MS);
        try {
            await page.waitForFunction(() => {
                return Array.from(document.querySelectorAll('table')).some(table => {
                    const headers = Array.from(table.querySelectorAll('th'))
                        .map(cell => (cell.textContent || '').trim().toLowerCase());
                    return headers.includes('date') && headers.includes('event') && headers.includes('price');
                });
            }, { timeout: RETRY_WAIT_MS });
            tableFound = true;
        } catch (e) {}
    }

    if (tableFound) {
        console.log(`   📊 [${tag}] Table mounted ✅`);
    } else {
        console.log(`   📊 [${tag}] Table NOT mounted ❌`);
        try {
            const debug = await page.evaluate(() => ({
                dateInfoCount: document.querySelectorAll('[data-testid="date-info"]').length,
                tableCount: document.querySelectorAll('table').length,
                showMoreLabels: document.querySelectorAll('span[data-c11n-component="TextButton.Label"]').length,
                bodyHeight: document.body.scrollHeight,
                viewportHeight: window.innerHeight,
                zoom: document.documentElement.style.zoom,
            }));
            console.log(`   🔍 [${tag}] Debug: ${JSON.stringify(debug)}`);
        } catch (e) {}
    }

    return tableFound;
}

// =========================================================
// EXTRACT ONE URL
// =========================================================
async function scrapeOneUrl(browser, url) {
    const tag = String(url).slice(-22);
    const ctx = await newContext(browser);
    let page;
    try {
        page = await ctx.newPage();

        // ---- Enable everything: JS, service workers, WebGL, etc.
        await page.setJavaScriptEnabled(true);
        try { await page.setBypassCSP(true); } catch (e) {}
        await page.setViewport({
            width: VIEWPORT_W,
            height: VIEWPORT_H,
            deviceScaleFactor: 1,
            hasTouch: false,
            isMobile: false,
        });

        // ---- Conditional request interception ----
        if (BLOCK_RESOURCES) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type) || AD_HOSTS.test(req.url())) req.abort().catch(() => {});
                else req.continue().catch(() => {});
            });
        } else {
            // Load EVERYTHING — no blocking at all
            await page.setRequestInterception(true);
            page.on('request', (req) => req.continue().catch(() => {}));
        }

        // Small UA fix for headless mode — keep if you use headless
        try {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                if (!window.chrome) window.chrome = {};
                if (!window.chrome.runtime) window.chrome.runtime = {};
            });
        } catch (e) {}

        await delay(jitter(NAV_DELAY_MIN, NAV_DELAY_MAX));
        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"]', { timeout: HYDRATE_TIMEOUT }).catch(() => {});
        await delay(HYDRATE_SETTLE);

        const title = await page.title();
        const hasNext = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
        const blockedTitle = /pardon our interruption|robot check|access denied/i.test(title);
        if (blockedTitle || !hasNext) return { blocked: true, blockedTitle };

        const tableFound = await ensureHistoryMounted(page, tag);

        const data = await page.evaluate(() => {
            const out = {
                price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
                agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
                pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
                listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
                hoa: "", priceHistoryText: "", pageText: ""
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

            // JSON fallback
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

            return out;
        });

        if (!data.canonicalUrl) data.canonicalUrl = url;

        let domRows = [];
        try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}

        if (!domRows.length) {
            try { domRows = await page.evaluate(fallbackHistoryParse); } catch (e) {}
            if (domRows.length) console.log(`   🔁 [${tag}] Fallback history found: ${domRows.length} rows`);
        }

        if (domRows.length) {
            data.priceHistoryText = domRows.map(r => {
                const priceTxt = r.price + (r.change ? ` (${r.change})` : '');
                return [r.date, r.event, priceTxt, r.ppsf, r.source].filter(Boolean).join(' | ');
            }).join('\n');
            for (const r of domRows) {
                const ev = String(r.event || '').toLowerCase();
                if (ev.includes('listed for sale') && !data.listedForSale) data.listedForSale = `${r.date} (${r.price})`;
                if (ev.includes('sold') && !data.soldOn) data.soldOn = r.date;
            }
            if (!data.mls) {
                for (const r of domRows) {
                    const m = String(r.source || '').match(/Source:\s*(.+?MLS)\s*#\s*([A-Za-z0-9-]+)/i);
                    if (m) { data.mls = `${m[2].replace(/Originating.*$/i, '').trim()} - ${m[1].trim()}`; break; }
                }
            }
            console.log(`   📊 [${tag}] History: ${domRows.length} row(s)`);
            domRows.forEach(r => console.log(`       ${r.date} | ${r.event} | ${r.price}${r.change ? ' (' + r.change + ')' : ''}`));
        } else {
            console.log(`   ⚠️ [${tag}] History: EMPTY${data.priceHistoryText ? ' (JSON fallback OK)' : ''}`);
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
                data.description = ldDesc || 'N/A';
            } catch (e) { data.description = data.description || 'N/A'; }
        }

        data.factsFeaturesText = "";
        try {
            data.factsFeaturesText = await page.evaluate(() => {
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
                const h = Array.from(document.querySelectorAll('h2,h3'))
                    .find(x => /^Facts\s*&\s*[Ff]eatures$/i.test(clean(x.textContent)));
                if (!h || !h.parentElement) return "";
                const lines = [];
                h.parentElement.querySelectorAll('*').forEach(el => {
                    if (/^(P|LI|SPAN|DIV|H[1-6])$/i.test(el.tagName)) {
                        const t = clean(el.textContent);
                        if (t && t.length < 300 && !lines.includes(t)) lines.push(t);
                    }
                });
                return lines.join('\n');
            }) || "";
        } catch (e) {}

        return { blocked: false, data, tableFound, domRowsFound: domRows.length };
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
    console.log(`🚀 Stealth Scraper V23 — full browser (JS/WebGL/ServiceWorkers enabled), resource blocking: ${BLOCK_RESOURCES ? 'ON' : 'OFF'}`);

    const setOutput = (hasMore, blocked) => {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`);
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
    let totalWithHistory = 0, totalWithTableFound = 0;
    let cursor = -1;
    let stop = false, blockedExit = false;
    const inflight = new Map();

    const claimRow = () => {
        const r = findNextRow(sheet, cursor, claimed === 0 && RETRY_BLOCKED);
        if (r !== -1) cursor = r;
        return r;
    };

    async function worker(id) {
        let browser = null, used = 0;
        try {
            while (!stop) {
                if (Date.now() - startTime >= MAX_RUNTIME_MS) break;
                if (claimed >= MAX_URLS_PER_RUN) break;
                if (errorStreak >= MAX_CONSECUTIVE_ERRORS) { stop = true; break; }

                const rowIndex = claimRow();
                if (rowIndex === -1) break;
                claimed++;
                const url = String(safeValue(sheet, rowIndex, 0));
                const actualRow = rowIndex + 1;
                console.log(`🕵️ [W${id}] Row ${actualRow} (${claimed}/${MAX_URLS_PER_RUN}): ${url}`);

                let recycle = false;
                try {
                    if (!browser || used >= RECYCLE_BROWSER_EVERY) {
                        await closeBrowser(browser);
                        browser = await launchBrowser();
                        used = 0;
                    }
                    used++;

                    const key = urlKey(url);
                    if (!inflight.has(key)) inflight.set(key, scrapeOneUrl(browser, url));
                    const result = await inflight.get(key);

                    if (result.blocked) {
                        console.log(`❌ [W${id}] BLOCKED on Row ${actualRow}`);
                        queue.push({ row: rowIndex, status: result.blockedTitle ? "❌ BLOCKED (skipped)" : "🚫 No data - blocked? (skipped)" });
                        blockStreak++; errorStreak = 0; totalBlocks++;
                        recycle = true;
                        if (blockStreak >= MAX_CONSECUTIVE_BLOCK_STREAKS) { stop = true; blockedExit = true; }
                    } else {
                        const d = result.data;
                        if (result.tableFound) totalWithTableFound++;
                        if (d.priceHistoryText) totalWithHistory++;

                        if (!(d.price || d.fullAddress || d.description)) {
                            console.log(`⚠️ [W${id}] Empty parse on Row ${actualRow}`);
                            queue.push({ row: rowIndex, status: "⚠️ Empty parse (skipped)" });
                            errorStreak++; totalErrors++;
                        } else {
                            queue.push({ row: rowIndex, status: "✅ Done", d });
                            success++; blockStreak = 0; errorStreak = 0;
                            console.log(`✔️ [W${id}] ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${d.priceHistoryText ? d.priceHistoryText.split('\n').length : 'NO'} | 🏷️ ${d.mls || '—'}`);
                        }
                    }
                } catch (e) {
                    console.error(`🛑 [W${id}] Error on Row ${actualRow}: ${e.message}`);
                    queue.push({ row: rowIndex, status: "🛑 Error: " + String(e.message).slice(0, 100) });
                    errorStreak++; totalErrors++;
                    recycle = true;
                } finally {
                    inflight.delete(urlKey(url));
                }

                if (recycle) { await closeBrowser(browser); browser = null; }
                if (queue.length >= FLUSH_EVERY) flush();
            }
        } finally {
            await closeBrowser(browser);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
    await flush();

    console.log(`\n📊 ─── RUN TOTALS ───`);
    console.log(`✅ Success: ${success} | 🚫 Blocked: ${totalBlocks} | 🛑 Errors: ${totalErrors}`);
    console.log(`📊 Rows with history: ${totalWithHistory} | 📊 Table-mounted rows: ${totalWithTableFound}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    if (blockedExit) {
        console.log(`🛑 ${MAX_CONSECUTIVE_BLOCK_STREAKS} consecutive blocks — exiting so GitHub starts a new batch.`);
        setOutput(true, true);
        return;
    }

    const remaining = RETRY_BLOCKED ? findNextRow(sheet, cursor, true) : findNextRow(sheet, -1, false);
    const hasMore = remaining !== -1;
    setOutput(hasMore, false);
    console.log(hasMore ? `🔄 More rows remain — next run resumes at row ${remaining + 1}.` : "🎉 Sheet fully processed!");
}

runScraper().then(() => process.exit(0)).catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
