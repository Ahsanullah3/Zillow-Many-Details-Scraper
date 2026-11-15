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
const MAX_ROWS_PER_BATCH = 30;
const FLUSH_BATCH_SIZE = 10;
const REQUIRED_COLS = 34;
const MAX_BLOCK_STREAK = 3;
const MAX_RELAUNCHES = 3;              // after this many fresh relaunches still blocked → exit
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_RUNTIME_MS = 60 * 60 * 1000;
const RETRY_BLOCKED = process.env.RETRY_BLOCKED === '1';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

const PAGE_ZOOM = Number(process.env.PAGE_ZOOM || '0.05');
const VIEWPORT_W = 1400;
const VIEWPORT_H = 900;

const NAV_DELAY_MIN = 400;
const NAV_DELAY_MAX = 900;
const HYDRATE_TIMEOUT = 8000;
const HYDRATE_SETTLE = 500;
const ZOOM_WAIT = 1500;

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

// =========================================================
// FRESH BROWSER LAUNCH + PURGE
// =========================================================
function makeFreshProfileDir() {
    return path.join(os.tmpdir(), `zillow-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function launchFreshBrowser() {
    const userDataDir = makeFreshProfileDir();
    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
            '--incognito',
        ],
    });
    return { browser, userDataDir };
}

async function purgeBrowser(browser) {
    try {
        const pages = await browser.pages();
        if (pages.length) {
            const client = await pages[0].createCDPSession();
            await client.send('Network.clearBrowserCookies').catch(() => {});
            await client.send('Network.clearBrowserCache').catch(() => {});
            await client.send('Storage.clearDataForOrigin', {
                origin: 'https://www.zillow.com',
                storageTypes: 'all',
            }).catch(() => {});
        }
    } catch (e) {}
    try { await browser.close(); } catch (e) {}
}

// =========================================================
// GOOGLE API RETRY
// =========================================================
async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { await sheet.saveUpdatedCells(); return; }
        catch (error) {
            if (i === retries - 1) throw error;
            await delay((2 ** i) * 1000);
        }
    }
}

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
// EXTRACT
// =========================================================
async function extractPageData(page, originalUrl) {
    try {
        await page.evaluate((z) => {
            document.documentElement.style.zoom = String(z);
            if (document.body) document.body.style.zoom = String(z);
        }, PAGE_ZOOM);
    } catch (e) {}
    try {
        const client = await page.createCDPSession();
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: VIEWPORT_W, height: VIEWPORT_H,
            deviceScaleFactor: 1, mobile: false, scale: PAGE_ZOOM,
        });
    } catch (e) {}

    await delay(ZOOM_WAIT);

    await page.evaluate(() => {
        const tv = Array.from(document.querySelectorAll('button, [role="button"], a'))
            .find(b => /^\s*table\s+view\s*$/i.test((b.textContent || '').trim()));
        if (tv) tv.click();
    }).catch(() => {});
    await delay(400);

    await page.waitForFunction(() => {
        const tables = document.querySelectorAll('table');
        return Array.from(tables).some(t => {
            const hs = Array.from(t.querySelectorAll('th')).map(x => (x.textContent || '').trim().toLowerCase());
            return hs.includes('date') && hs.includes('event') && hs.includes('price');
        });
    }, { timeout: 6000 }).catch(() => {});

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
        return out;
    });

    if (!data.canonicalUrl) data.canonicalUrl = originalUrl;

    let domRows = [];
    try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
    if (!domRows.length) {
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => /price\s*history/i.test(x.textContent || ''));
            if (h) h.scrollIntoView({ block: 'center' });
        }).catch(() => {});
        await delay(1200);
        try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
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

    return data;
}

// =========================================================
// FIND START ROW
// =========================================================
function findStartRow(sheet) {
    for (let r = 1; r < sheet.rowCount; r++) {
        const url = sheet.getCell(r, 0).value;
        if (!url || !String(url).includes("zillow.com")) continue;
        if (isDoneStatus(sheet.getCell(r, 17).value || "")) continue;
        return r;
    }
    return -1;
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log(`🚀 Stealth Scraper V15 — zoom ${PAGE_ZOOM * 100}%, fresh-relaunch, 3-relaunch GitHub handoff`);

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

    const setCell = (r, c, v) => { if (c < sheet.columnCount) sheet.getCell(r, c).value = safeCell(v); };

    let dirty = 0;
    try {
        HEADERS.forEach((title, i) => {
            const col = HEADER_START_COL + i;
            if (col >= sheet.columnCount) return;
            const cell = sheet.getCell(0, col);
            if (OVERWRITE_HEADERS || !cell.value) { cell.value = title; try { cell.textFormat = { bold: true }; } catch (e) {} dirty++; }
        });
        if (dirty) { await saveWithRetry(sheet); dirty = 0; }
    } catch (e) { console.warn(`⚠️ Headings: ${e.message}`); }

    // ---- First fresh browser
    let { browser } = await launchFreshBrowser();
    console.log("🌐 Launched fresh browser (new profile)");

    const flush = async () => { if (dirty > 0) { await saveWithRetry(sheet); dirty = 0; } };

    let totalSuccess = 0, totalSkipped = 0, totalErrors = 0, totalBlocks = 0;
    let batchNum = 0;
    let relaunchCount = 0;

    while (Date.now() - startTime < MAX_RUNTIME_MS) {
        batchNum++;
        console.log(`\n📦 ─── Batch #${batchNum} (relaunch ${relaunchCount}/${MAX_RELAUNCHES}) ───`);

        const startRow = findStartRow(sheet);
        if (startRow === -1) {
            console.log("🎉 All rows ✅ Done — nothing left.");
            break;
        }
        console.log(`▶️ Starting at sheet row ${startRow + 1}`);

        let attempted = 0, success = 0, blockedInBatch = 0, errorsInBatch = 0;
        let blockStreak = 0, consecutiveErrors = 0;
        let triggeredRelaunch = false;

        for (let rowIndex = startRow; rowIndex < sheet.rowCount; rowIndex++) {
            if (Date.now() - startTime > MAX_RUNTIME_MS) { console.log("⏰ Runtime cap."); break; }
            if (attempted >= MAX_ROWS_PER_BATCH) { console.log(`📦 Batch reached ${MAX_ROWS_PER_BATCH} attempts.`); break; }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { console.log(`🛑 ${MAX_CONSECUTIVE_ERRORS} errors in a row.`); break; }

            const url = sheet.getCell(rowIndex, 0).value;
            const status = sheet.getCell(rowIndex, 17).value || "";
            if (!url || !String(url).includes("zillow.com")) continue;
            if (isDoneStatus(status)) continue;
            if (isSkipStatus(status) && !RETRY_BLOCKED) { totalSkipped++; continue; }

            const actualRow = rowIndex + 1;
            attempted++;
            console.log(`🕵️ Row ${actualRow}: ${url}`);

            const page = await browser.newPage();
            try {
                await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {});
                    else req.continue().catch(() => {});
                });

                await delay(jitter(NAV_DELAY_MIN, NAV_DELAY_MAX));
                await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForSelector('[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"]', { timeout: HYDRATE_TIMEOUT }).catch(() => {});
                await delay(HYDRATE_SETTLE);

                const title = await page.title();
                const hasNext = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
                const blockedTitle = /pardon our interruption|robot check|access denied/i.test(title);

                if (blockedTitle || !hasNext) {
                    console.log(`❌ BLOCKED on Row ${actualRow}`);
                    setCell(rowIndex, 17, blockedTitle ? "❌ BLOCKED (skipped)" : "🚫 No data - blocked? (skipped)");
                    dirty++;
                    blockStreak++;
                    blockedInBatch++;
                    totalBlocks++;

                    if (blockStreak >= MAX_BLOCK_STREAK) {
                        relaunchCount++;
                        console.log(`\n🔄 Block streak ${blockStreak}. Relaunch #${relaunchCount}/${MAX_RELAUNCHES}`);
                        if (relaunchCount > MAX_RELAUNCHES) {
                            console.log(`🛑 ${MAX_RELAUNCHES} fresh relaunches still blocked.`);
                            console.log(`📤 Exiting so GitHub Actions starts a brand-new batch (new runner, new IP, new cookies).`);
                            try { await flush(); } catch (e) {}
                            setOutput(true, true); // has_more=true, blocked=true → GitHub re-dispatches
                            await purgeBrowser(browser);
                            process.exit(0);
                        }
                        // Fresh relaunch: purge cookies/cache, new profile dir
                        await flush();
                        await purgeBrowser(browser);
                        const fresh = await launchFreshBrowser();
                        browser = fresh.browser;
                        console.log(`✅ Fresh browser launched (new profile, no cookies)`);
                        blockStreak = 0;
                        consecutiveErrors = 0;
                        triggeredRelaunch = true;
                        break; // break inner loop → next batch starts fresh at findStartRow
                    }
                } else {
                    const d = await extractPageData(page, String(url));
                    if (!(d.price || d.fullAddress || d.description)) {
                        setCell(rowIndex, 17, "⚠️ Empty parse (skipped)");
                        dirty++;
                        consecutiveErrors++;
                        errorsInBatch++;
                        totalErrors++;
                    } else {
                        setCell(rowIndex, 9,  d.price);
                        setCell(rowIndex, 10, d.street);
                        setCell(rowIndex, 11, d.city);
                        setCell(rowIndex, 12, d.state);
                        setCell(rowIndex, 13, d.zipcode);
                        setCell(rowIndex, 14, d.canonicalUrl);
                        setCell(rowIndex, 15, d.agentDetails);
                        setCell(rowIndex, 16, d.soldPrice);
                        setCell(rowIndex, 17, "✅ Done");
                        setCell(rowIndex, 18, d.description);
                        setCell(rowIndex, 19, d.fullAddress);
                        setCell(rowIndex, 20, d.pricePerSqft);
                        setCell(rowIndex, 21, d.beds);
                        setCell(rowIndex, 22, d.baths);
                        setCell(rowIndex, 23, d.sqft);
                        setCell(rowIndex, 24, d.lotSize);
                        setCell(rowIndex, 25, d.listedForSale);
                        setCell(rowIndex, 26, d.soldOn);
                        setCell(rowIndex, 27, d.mls);
                        setCell(rowIndex, 28, d.propertyType);
                        setCell(rowIndex, 29, d.yearBuilt);
                        setCell(rowIndex, 30, d.hoa);
                        setCell(rowIndex, 31, d.priceHistoryText);
                        setCell(rowIndex, 32, d.factsFeaturesText);
                        setCell(rowIndex, 33, d.pageText);
                        dirty++;
                        success++;
                        totalSuccess++;
                        blockStreak = 0;
                        consecutiveErrors = 0;
                        console.log(`✔️ ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${d.priceHistoryText ? 'YES (' + d.priceHistoryText.split('\n').length + ')' : 'NO'} | 🏷️ MLS: ${d.mls || '—'}`);
                    }
                }
            } catch (e) {
                console.error(`🛑 Error on Row ${actualRow}: ${e.message}`);
                setCell(rowIndex, 17, "🛑 Error: " + e.message.slice(0, 100));
                dirty++;
                consecutiveErrors++;
                errorsInBatch++;
                totalErrors++;
            } finally {
                await page.close().catch(() => {});
            }

            if (dirty >= FLUSH_BATCH_SIZE) { console.log(`💾 Saving ${dirty} rows...`); await flush(); }
        }

        try { await flush(); } catch (e) {}
        console.log(`📊 Batch #${batchNum}: ${success}✅ / ${blockedInBatch}🚫 / ${errorsInBatch}🛑 / ${attempted} attempted${triggeredRelaunch ? ' (relaunched)' : ''}`);
    }

    try { await purgeBrowser(browser); } catch (e) {}

    console.log(`\n📊 ─── FINAL ───`);
    console.log(`✅ Success: ${totalSuccess} | 🚫 Blocked: ${totalBlocks} | 🛑 Errors: ${totalErrors} | ⏭️ Skipped: ${totalSkipped}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    const remaining = findStartRow(sheet);
    const hasMore = remaining !== -1;
    setOutput(hasMore, totalBlocks > 0 && totalSuccess === 0);
    console.log(hasMore ? `🔄 Resume next run at row ${remaining + 1}` : "🎉 Sheet fully processed!");
}

runScraper().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
