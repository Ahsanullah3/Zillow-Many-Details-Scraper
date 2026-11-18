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
const CONCURRENCY = Number(process.env.CONCURRENCY || '4');
const MAX_URLS_PER_RUN = Number(process.env.MAX_URLS_PER_RUN || '150');
const FLUSH_EVERY = 5;
const REQUIRED_COLS = 34;
const MAX_CONSECUTIVE_BLOCK_STREAKS = Number(process.env.MAX_BLOCK_STREAK || '6');
const MAX_CONSECUTIVE_ERRORS = 6;
const MAX_RUNTIME_MS = 60 * 60 * 1000;
const RECYCLE_BROWSER_EVERY = 2;

const RETRY_BLOCKED = process.env.RETRY_BLOCKED !== '0';

const HEADFUL = process.env.HEADFUL === '1';
const CHROME_PATH = process.env.CHROME_PATH || '';
const CHROME_CHANNEL = process.env.CHROME_CHANNEL || '';

const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES === '0';
const INCLUDE_PAGE_TEXT = true;
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';

const VIEWPORT_W = Number(process.env.VIEWPORT_W || '1400');
const VIEWPORT_H = Number(process.env.VIEWPORT_H || '900');
const HYDRATE_TIMEOUT = Number(process.env.HYDRATE_TIMEOUT || '12000');
const HISTORY_WAIT_MS = Number(process.env.HISTORY_WAIT_MS || '20000');
const ZOOM_PERCENT = Number(process.env.ZOOM_PERCENT || '20');   // ✅ page zoom level

const HEADER_START_COL = 9;
const HEADERS = [
    "Price", "Street", "City", "State", "Zipcode", "Final URL", "Agent Details", "Sold Price",
    "Status", "Description", "Full Address", "Price Per Sqft", "Beds", "Baths", "Sqft", "Lot Size",
    "Listed For Sale", "Sold On", "MLS", "Property Type", "Year Built", "HOA",
    "Price History", "Facts & Features", "Page Text (Formatted)"
];
const OVERWRITE_HEADERS = process.env.OVERWRITE_HEADERS === '1';

console.log(`🧩 Resource blocking: ${BLOCK_RESOURCES ? 'ON' : 'OFF (all resources load)'} | headful: ${HEADFUL} | zoom: ${ZOOM_PERCENT}% | pageText: ON`);

const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse|no history/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_CELL_LEN = 49000;
const MAX_PAGETEXT_LEN = 49900;
const safeCell = (v, limit = MAX_CELL_LEN) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > limit ? s.slice(0, limit) + "…[truncated]" : s;
};

const AD_HOSTS = /doubleclick|googletagmanager|google-analytics|googlesyndication|facebook\.net|facebook\.com|criteo|taboola|adsrvr|tiktok|snapchat|hotjar|fullstory|bing\.com|quantserve|scorecardresearch/i;

// =========================================================
// BROWSER
// =========================================================
async function launchBrowser() {
    const userDataDir = path.join(os.tmpdir(), `zillow-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        '--autoplay-policy=no-user-gesture-required',
        '--lang=en-US,en',
    ];
    const opts = { headless: HEADFUL ? false : true, userDataDir, args };
    if (CHROME_PATH) opts.executablePath = CHROME_PATH;
    else if (CHROME_CHANNEL) opts.channel = CHROME_CHANNEL;

    const browser = await puppeteer.launch(opts);
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
            await delay((2 ** i) * 1000); // API backoff only
        }
    }
}

function safeValue(sheet, row, col) {
    try {
        const v = sheet.getCell(row, col).value;
        return v === null || v === undefined ? "" : String(v);
    } catch (e) {
        return "";
    }
}

function findNextRow(sheet, afterRow, mode) {
    for (let r = afterRow + 1; r < sheet.rowCount; r++) {
        const url = safeValue(sheet, r, 0);
        if (!url || !url.includes("zillow.com")) continue;
        const status = safeValue(sheet, r, 17);
        if (isDoneStatus(status)) continue;
        const skipped = isSkipStatus(status);
        if (mode === 'fresh' && skipped) continue;
        if (mode === 'skipped' && !skipped) continue;
        return r;
    }
    return -1;
}

const urlKey = (u) => String(u).trim().split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();

// =========================================================
// ✅ ZOOM + PAGE SCROLL (no timed delays — frame-based, stops when history mounts)
// =========================================================
async function zoomAndScroll(page, tag) {
    try {
        await page.evaluate(async (zoomPct) => {
            const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const hasHistory = () => Array.from(document.querySelectorAll('h2,h3,h4'))
                .some(x => (x.textContent || '').replace(/\u00A0/g, ' ').trim().toLowerCase() === 'price history');

            // Zoom out so far more of the page is in the viewport at once
            document.documentElement.style.zoom = String(zoomPct / 100);
            await frame();

            const step = Math.max(200, window.innerHeight);
            let lastHeight = -1, stable = 0;

            // Walk down the page in viewport steps so lazy modules mount
            for (let round = 0; round < 60; round++) {
                window.scrollBy(0, step);
                await frame();
                const h = document.documentElement.scrollHeight;
                const atBottom = (window.scrollY + window.innerHeight) >= (h - 5);
                if (hasHistory() && atBottom) break;
                if (h === lastHeight) stable++; else { stable = 0; lastHeight = h; }
                if (atBottom && stable >= 2) break;
            }

            // Jump to the bottom
            window.scrollTo(0, document.documentElement.scrollHeight);
            await frame();
        }, ZOOM_PERCENT);
    } catch (e) {
        console.log(`   ⚠️ [${tag}] zoomAndScroll error: ${e.message}`);
    }
}

// =========================================================
// ✅ PRICE HISTORY — visible DOM table ONLY (no JSON / no fallback locators)
// =========================================================
const FIND_TABLE_FN = `
    const norm = (s) => (s || '').replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    const findTable = () => {
        const h = Array.from(document.querySelectorAll('h2,h3,h4')).find(x => norm(x.textContent) === 'price history');
        if (!h) return null;
        let root = h.parentElement;
        for (let i = 0; i < 5 && root; i++) {
            const t = root.querySelector('table');
            if (t) return t;
            root = root.parentElement;
        }
        return null;
    };
`;

async function getPriceHistory(page, tag) {
    await zoomAndScroll(page, tag);

    // Wait until the Price history table has rows
    const found = await page.waitForFunction(new Function(`
        ${FIND_TABLE_FN}
        const t = findTable();
        return !!(t && t.querySelectorAll('tbody tr').length > 0);
    `), { timeout: HISTORY_WAIT_MS, polling: 'raf' }).then(() => true).catch(() => false);

    if (!found) {
        console.log(`   📊 [${tag}] Price history table NOT found on page`);
        return { rows: [], found: false };
    }

    // Expand "Show more" — wait on row count increasing instead of fixed delays
    let clicks = 0;
    for (let i = 0; i < 25; i++) {
        const state = await page.evaluate(new Function(`
            ${FIND_TABLE_FN}
            const table = findTable();
            if (!table) return { count: 0, clicked: false };
            const count = table.querySelectorAll('tbody tr').length;
            const root2 = table.closest('div') || table.parentElement;
            const btn = (root2 && root2.querySelector('tfoot[data-testid="table-see-more"] button, tfoot button')) ||
                        document.querySelector('tfoot[data-testid="table-see-more"] button, tfoot button');
            if (btn && /show more|see more/i.test(btn.textContent || '')) {
                btn.click();
                return { count, clicked: true };
            }
            return { count, clicked: false };
        `)).catch(() => ({ count: 0, clicked: false }));

        if (!state.clicked) break;
        clicks++;
        const grew = await page.waitForFunction(new Function('prev', `
            ${FIND_TABLE_FN}
            const t = findTable();
            return !!t && t.querySelectorAll('tbody tr').length > prev;
        `), { timeout: 3000, polling: 'raf' }, state.count).then(() => true).catch(() => false);
        if (!grew) break;
    }
    if (clicks) console.log(`   🔽 [${tag}] Expanded price history (${clicks} click(s))`);

    // Parse rows
    const rows = await page.evaluate(new Function(`
        ${FIND_TABLE_FN}
        const clean = (s) => (s || '').replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').trim();
        const table = findTable();
        if (!table) return [];

        const out = [];
        for (const tr of table.querySelectorAll('tbody tr')) {
            const dateEl = tr.querySelector('[data-testid="date-info"]');
            const label = tr.getAttribute('label') || '';
            if (!dateEl && !label) continue;

            const lm = label.match(/Date:\\s*(.+?),\\s*Event:\\s*(.+?),\\s*Price:\\s*(.*)$/i);
            const cells = tr.querySelectorAll('td');
            const date = clean(dateEl && dateEl.textContent) || (lm ? clean(lm[1]) : '');
            const event = (cells[1] ? clean(cells[1].textContent) : '') || (lm ? clean(lm[2]) : '');

            let price = '', change = '', ppsf = '';
            const priceCell = tr.querySelector('[data-testid="price-money-cell"]');
            if (priceCell) {
                const first = priceCell.querySelector('span > span');
                price = clean(first && first.textContent);
                const pct = priceCell.querySelector('[data-testid="percent-display"]');
                change = clean(pct && pct.textContent);
                const last = priceCell.lastElementChild;
                const lastTxt = clean(last && last.textContent);
                if (/sqft/i.test(lastTxt)) ppsf = lastTxt;
            }
            if (!price && lm) {
                const raw = clean(lm[3]);
                if (!change) change = (raw.match(/\\(([^)]+)\\)/) || [])[1] || '';
                price = raw.replace(/\\s*\\(.*\\)\\s*/, '').replace(/\\s*null$/i, '').trim();
            }
            if (/^[-—–]+$/.test(price)) price = '';

            let source = '';
            const next = tr.nextElementSibling;
            if (next && !next.hasAttribute('label') && !next.querySelector('[data-testid="date-info"]')) {
                source = clean(next.textContent).replace(/\\s*Report\\s+a\\s+problem\\s*$/i, '').replace(/\\s*Report\\s*$/i, '');
            }
            out.push({ date, event, price, change, ppsf, source });
        }
        return out;
    `)).catch(() => []);

    return { rows, found: true };
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
        await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, hasTouch: false, isMobile: false });

        if (BLOCK_RESOURCES) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['image', 'font', 'media'].includes(type) || AD_HOSTS.test(req.url())) req.abort().catch(() => {});
                else req.continue().catch(() => {});
            });
        }

        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"], h1', { timeout: HYDRATE_TIMEOUT }).catch(() => {});

        const title = await page.title();
        const hasContent = await page.evaluate(() => !!document.querySelector('h1, [data-testid="price"]'));
        const blockedTitle = /pardon our interruption|robot check|access denied|denied|captcha|press & hold/i.test(title);
        if (blockedTitle || !hasContent) {
            if (DEBUG_DUMP) await dumpDebug(page, 'blocked');
            return { blocked: true, blockedTitle };
        }

        // ---- Price history (zoom + scroll + visible table only)
        const { rows: domRows, found: tableFound } = await getPriceHistory(page, tag);

        // ---- Main page data
        const data = await page.evaluate((INCLUDE_PAGE_TEXT) => {
            const out = {
                price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
                agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
                pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
                listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
                hoa: "", priceHistoryText: "", pageText: "", factsFeaturesText: ""
            };
            const clean = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
            const num = (s) => {
                const str = String(s || '').replace(/,/g, '').trim();
                if (/^[-—–]+$/.test(str)) return '';
                const m = str.match(/-?\d+(\.\d+)?/);
                return m ? Number(m[0]) : '';
            };
            const $ = (sel, root = document) => root.querySelector(sel);
            const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
            const txt = (sel) => { const e = $(sel); return e ? e.textContent : ''; };

            const og = $('meta[property="og:url"]');
            const canon = $('link[rel="canonical"]');
            out.canonicalUrl = (og && og.content) || (canon && canon.href) || location.href;
            out.price = num(clean(txt('[data-testid="price"]')));

            const pill = clean(txt('[data-testid="gallery-status-pill"]'));
            const soldMatch = pill.match(/Sold\s+for\s+\$([\d,]+)/i);
            if (soldMatch) out.soldPrice = Number(soldMatch[1].replace(/,/g, ''));
            else if (/sold/i.test(pill) && out.price) out.soldPrice = out.price;

            const h1 = clean(txt('h1'));
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
                    const lotM = t.match(/^([\d.,]+)\s*(Acres?|sqft|sq\s*ft)\s+Lot$/i);
                    if (lotM && !out.lotSize) out.lotSize = `${lotM[1]} ${/acre/i.test(lotM[2]) ? 'Acres' : 'sqft'}`;
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
            const ffLines = [];
            $$('[data-testid="category-group"]').forEach(group => {
                const ghEl = group.querySelector('h3');
                const gh = clean(ghEl ? ghEl.textContent : '');
                if (gh) ffLines.push(`## ${gh}`);
                group.querySelectorAll('[data-testid="fact-category"]').forEach(cat => {
                    const ch = cat.querySelector('h6');
                    const items = Array.from(cat.querySelectorAll('li')).map(li => clean(li.textContent)).filter(Boolean);
                    if (!items.length) return;
                    ffLines.push(ch ? `${clean(ch.textContent)}: ${items.join('; ')}` : items.join('; '));
                });
            });
            out.factsFeaturesText = ffLines.join('\n');

            if (!out.propertyType && (fm['Home type'] || fm['Property subtype'])) out.propertyType = fm['Home type'] || fm['Property subtype'];
            if (!out.yearBuilt && fm['Year built']) out.yearBuilt = fm['Year built'];
            if (!out.lotSize && fm['Size']) out.lotSize = fm['Size'];
            if (!out.pricePerSqft && fm['Price per square foot']) out.pricePerSqft = num(fm['Price per square foot']);

            const hasHoa = fm['Has HOA'];
            const hoaFee = fm['HOA fee'] || fm['HOA fee frequency'];
            if (hoaFee) out.hoa = hoaFee;
            else if (hasHoa) out.hoa = /^no/i.test(hasHoa) ? 'No' : `Yes (${hasHoa})`;
            else out.hoa = '';

            const descEl = $('[data-testid="description"] article') || $('[data-testid="description"]');
            if (descEl) out.description = clean(descEl.textContent) || 'N/A';

            const la = $('[data-testid="attribution-LISTING_AGENT"]');
            if (la) {
                const parts = Array.from(la.querySelectorAll('span')).map(x => clean(x.textContent).replace(/,$/, '')).filter(Boolean);
                const broker = clean(txt('[data-testid="attribution-BROKER"]'));
                out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
            }

            const mlsInfo = clean(txt('[role="contentinfo"][aria-label="MLS information"]'));
            if (mlsInfo) {
                const src = mlsInfo.match(/Source:\s*(.+?)\s*,\s*MLS#?:/i);
                const id = mlsInfo.match(/MLS#?:\s*([A-Za-z0-9-]+?)(?=Originating|\s|$)/i);
                if (id) out.mls = `${id[1]} - ${src ? clean(src[1]) : ''}`.replace(/ - $/, '');
            }

            // Page text
            if (INCLUDE_PAGE_TEXT) {
                const SKIP = new Set([
                    'SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','TEMPLATE','BUTTON',
                    'SELECT','INPUT','TEXTAREA','HEAD','LINK','META','PATH','IMG',
                    'VIDEO','AUDIO','CANVAS','OBJECT','EMBED'
                ]);
                const SKIP_TESTID = /topnav|desktop-action-bar|action-bar|footer|mobile-footer|neighborhood-ad|MstServicesAvailability|zhl-upsell|third-party|ad-frame|lightbox/i;

                const lines = [];
                const seen = new Set();
                const push = (s) => {
                    const t = clean(s);
                    if (!t || t.length < 2) return;
                    if (lines.length && lines[lines.length - 1] === t) return;
                    const k = t.toLowerCase();
                    if (t.length < 25 && seen.has(k)) return;
                    if (t.length < 25) seen.add(k);
                    lines.push(t);
                };

                const isHeading = (n) => /^H[1-6]$/.test(n.tagName);
                const isBlock = (n) => /^(DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|UL|OL|LI|P|TABLE|TBODY|THEAD|TR|TD|TH|DL|DT|DD|FIGURE|FIGCAPTION|BLOCKQUOTE|PRE)$/.test(n.tagName);

                const walk = (n, depth) => {
                    if (n.nodeType === 3) { push(n.nodeValue); return; }
                    if (n.nodeType !== 1) return;
                    const tag = n.tagName.toUpperCase();
                    if (SKIP.has(tag)) return;
                    if (n.getAttribute('aria-hidden') === 'true') return;
                    if (n.hidden) return;
                    const tid = n.getAttribute('data-testid') || '';
                    if (tid && SKIP_TESTID.test(tid)) return;

                    const aria = n.getAttribute('aria-label');
                    const ariaText = aria && aria.length > 2 && aria.length < 120 ? clean(aria) : '';

                    if (isHeading(n)) {
                        const t = clean(n.textContent);
                        if (t) { lines.push(''); lines.push(`## ${t}`); }
                        return;
                    }

                    if (tag === 'TABLE') {
                        for (const tr of n.querySelectorAll('tr')) {
                            const cells = Array.from(tr.querySelectorAll('th,td'))
                                .map(c => clean(c.textContent))
                                .filter(Boolean);
                            if (cells.length) push(cells.join(' | '));
                        }
                        return;
                    }

                    if (ariaText && !clean(n.textContent).startsWith(ariaText)) push(ariaText);

                    for (const c of n.childNodes) walk(c, depth + 1);

                    if (isBlock(n) && lines.length && lines[lines.length - 1] !== '') lines.push('');
                };

                const main = $('[data-test="hdp-not-for-sale-page-content"]')
                    || $('#layout-wrapper .layout-container')
                    || $('#layout-wrapper')
                    || document.body;

                walk(main, 0);

                const compact = [];
                for (const l of lines) {
                    if (l === '' && compact[compact.length - 1] === '') continue;
                    compact.push(l);
                }

                out.pageText = [
                    `TITLE: ${clean(document.title)}`,
                    `URL: ${location.href}`,
                    '',
                    ...compact
                ].join('\n').trim();
            }

            out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(', ');

            // JSON fallback for NON-history fields only (price / MLS / agent)
            try {
                const nd = $('script#__NEXT_DATA__');
                const nextData = nd ? JSON.parse(nd.textContent || 'null') : null;
                const raw = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.componentProps && nextData.props.pageProps.componentProps.gdpClientCache;
                if (raw) {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    for (const key of Object.keys(parsed)) {
                        const prop = parsed[key] && parsed[key].property;
                        if (!prop) continue;
                        if (!out.price && prop.price) out.price = prop.price;
                        if (!out.soldPrice && prop.lastSoldPrice) out.soldPrice = prop.lastSoldPrice;
                        const ai = prop.attributionInfo;
                        if (ai) {
                            if (!out.mls && (ai.mlsId || ai.mlsName)) out.mls = [ai.mlsId, ai.mlsName].filter(Boolean).join(' - ');
                            if (!out.agentDetails) out.agentDetails = [ai.agentName, ai.brokerName, ai.agentPhoneNumber].filter(Boolean).join(' | ');
                        }
                        break;
                    }
                }
            } catch (e) {}

            return out;
        }, INCLUDE_PAGE_TEXT);

        if (!data.canonicalUrl) data.canonicalUrl = url;

        // ---- Price history from visible DOM table only
        if (domRows.length) {
            data.priceHistoryText = domRows.map(r => {
                const priceTxt = (r.price || '') + (r.change ? ` (${r.change})` : '');
                return [r.date, r.event, priceTxt.trim(), r.ppsf, r.source].filter(Boolean).join(' | ');
            }).join('\n');
            for (const r of domRows) {
                const ev = String(r.event || '').toLowerCase();
                if (ev.includes('listed for sale') && !data.listedForSale) data.listedForSale = `${r.date} (${r.price})`;
                if (ev.includes('sold') && !data.soldOn) data.soldOn = r.date;
            }
            if (!data.mls) {
                for (const r of domRows) {
                    const m = String(r.source || '').match(/Source:\s*(.+?)\s*#\s*([A-Za-z0-9-]+)/i);
                    if (m) { data.mls = `${m[2]} - ${m[1].trim()}`; break; }
                }
            }
            console.log(`   📊 [${tag}] History: ${domRows.length} row(s)`);
            domRows.forEach(r => console.log(`       ${r.date} | ${r.event} | ${r.price}${r.change ? ' (' + r.change + ')' : ''}`));
        } else {
            console.log(`   ⚠️ [${tag}] History: EMPTY (tableFound=${tableFound})`);
            if (DEBUG_DUMP) await dumpDebug(page, 'nohistory');
        }

        // ---- Description fallback from JSON-LD
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

        return { blocked: false, data, tableFound, domRowsFound: domRows.length };
    } finally {
        if (page) await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }
}

async function dumpDebug(page, label) {
    try {
        const stamp = `${label}-${Date.now()}`;
        const dir = path.join(process.cwd(), 'debug');
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${stamp}.png`), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(dir, `${stamp}.html`), await page.content());
        console.log(`   🧾 Debug saved: debug/${stamp}.{png,html}`);
    } catch (e) {}
}

// =========================================================
// MAIN (unchanged)
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log(`🚀 Zillow Scraper V27 | concurrency ${CONCURRENCY} | max ${MAX_URLS_PER_RUN}`);

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
    const setCell = (r, c, v, limit) => { if (c < sheet.columnCount) sheet.getCell(r, c).value = safeCell(v, limit); };
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
        setCell(row, 33, d.pageText, MAX_PAGETEXT_LEN);
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
    let phase = 'fresh';
    let stop = false, blockedExit = false;
    const inflight = new Map();

    const claimRow = () => {
        let r = findNextRow(sheet, cursor, phase);
        if (r === -1 && phase === 'fresh' && RETRY_BLOCKED) {
            phase = 'skipped';
            cursor = -1;
            console.log('🔁 Fresh rows done — retrying previously skipped rows');
            r = findNextRow(sheet, cursor, phase);
        }
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
                console.log(`🕵️ [W${id}] Row ${actualRow} (${claimed}/${MAX_URLS_PER_RUN}) [${phase}]: ${url}`);

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
                        const hasHistory = !!(d.priceHistoryText && d.priceHistoryText.trim());
                        if (hasHistory) totalWithHistory++;

                        if (!(d.price || d.fullAddress || d.description)) {
                            console.log(`⚠️ [W${id}] Empty parse on Row ${actualRow}`);
                            queue.push({ row: rowIndex, status: "⚠️ Empty parse (skipped)" });
                            errorStreak++; totalErrors++;
                        } else {
                            const status = hasHistory ? "✅ Done" : "⚠️ Done (no history)";
                            queue.push({ row: rowIndex, status, d });
                            success++; blockStreak = 0; errorStreak = 0;
                            console.log(`✔️ [W${id}] ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${hasHistory ? d.priceHistoryText.split('\n').length : 'NO'} | 📄 Text: ${d.pageText ? d.pageText.length : 0} chars | 🏷️ ${d.mls || '—'}`);
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
    console.log(`📊 Rows with history: ${totalWithHistory} | 📊 History-section rows: ${totalWithTableFound}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    if (blockedExit) {
        console.log(`🛑 ${MAX_CONSECUTIVE_BLOCK_STREAKS} consecutive blocks — stopping.`);
        setOutput(true, true);
        return;
    }

    const remaining = findNextRow(sheet, -1, 'fresh');
    const hasMore = remaining !== -1;
    setOutput(hasMore, false);
    console.log(hasMore ? `🔄 More rows remain — next run resumes at row ${remaining + 1}.` : "🎉 All fresh rows processed!");
}

runScraper().then(() => process.exit(0)).catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
