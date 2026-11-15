const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG
// =========================================================
const MAX_ROWS_PER_RUN = 30;
const FLUSH_BATCH_SIZE = 8;
const REQUIRED_COLS = 34;
const MAX_BLOCK_STREAK = 3;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_RUNTIME_MS = 12 * 60 * 1000;
const RETRY_BLOCKED = process.env.RETRY_BLOCKED === '1';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));

const HEADER_START_COL = 9; // column J
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
// GOOGLE API RETRY
// =========================================================
async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return;
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API unavailable.");
                throw error;
            }
            console.log(`⚠️ Google API error. Retrying in ${2 ** i}s...`);
            await delay((2 ** i) * 1000);
        }
    }
}

// =========================================================
// PRICE HISTORY PARSER (in-page)
// =========================================================
function parseHistoryRowsInPage() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const isHistoryTable = (t) => {
        const hs = Array.from(t.querySelectorAll('th')).map(x => clean(x.textContent).toLowerCase());
        return hs.includes('date') && hs.includes('event') && hs.includes('price');
    };
    const candidates = Array.from(document.querySelectorAll(
        'table[data-c11n-component="Table.Root"], table.c11n_table__root, table'
    ));
    const table = candidates.find(isHistoryTable);
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
    // ---------- 1) SCROLL: full page top→bottom so lazy sections mount ----------
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const step = 400;
        const max = document.body.scrollHeight;
        for (let y = 0; y <= max; y += step) {
            window.scrollTo(0, y);
            await sleep(80);
        }
        window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});

    // ---------- 2) WAIT 2 SECONDS ----------
    await delay(2000);

    // ---------- 3) CLICK "Table view" toggle if present ----------
    await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const tv = els.find(b => /^\s*table\s+view\s*$/i.test((b.textContent || '').trim()));
        if (tv) tv.click();
    }).catch(() => {});
    await delay(600);

    // ---------- 4) Wait for the history table header row (up to 10s) ----------
    await page.waitForFunction(
        () => {
            const tables = document.querySelectorAll('table');
            return Array.from(tables).some(t => {
                const hs = Array.from(t.querySelectorAll('th')).map(x => (x.textContent || '').trim().toLowerCase());
                return hs.includes('date') && hs.includes('event') && hs.includes('price');
            });
        },
        { timeout: 10000 }
    ).catch(() => {});

    // ---------- 5) Extract all DOM fields ----------
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
            const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
            return m ? Number(m[0]) : '';
        };
        const $ = (sel, root = document) => root.querySelector(sel);
        const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

        out.canonicalUrl = $('meta[property="og:url"]')?.content || $('link[rel="canonical"]')?.href || location.href;

        // PRICE
        out.price = num(clean($('[data-testid="price"]')?.textContent));

        // SOLD PRICE from status pill
        const pill = clean($('[data-testid="gallery-status-pill"]')?.textContent);
        const soldMatch = pill.match(/Sold\s+for\s+\$([\d,]+)/i);
        if (soldMatch) out.soldPrice = Number(soldMatch[1].replace(/,/g, ''));
        else if (/sold/i.test(pill) && out.price) out.soldPrice = out.price;

        // ADDRESS from H1
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

        // BEDS / BATHS / SQFT
        const factMap = {};
        $$('[data-testid="bed-bath-sqft-fact-container"]').forEach(c => {
            const sp = c.querySelectorAll('span');
            if (sp.length >= 2) {
                const val = clean(sp[0].textContent);
                const key = clean(sp[1].textContent).toLowerCase();
                if (key) factMap[key] = val;
            }
        });
        if (factMap.beds)  out.beds  = num(factMap.beds)  || factMap.beds;
        if (factMap.baths) out.baths = num(factMap.baths) || factMap.baths;
        if (factMap.sqft)  out.sqft  = num(factMap.sqft)  || factMap.sqft;

        // "At a glance facts" grid
        const glance = $('[aria-label="At a glance facts"]');
        if (glance) {
            for (const item of glance.querySelectorAll('[role="listitem"]')) {
                const t = clean(item.textContent);
                if (!t) continue;
                const lotM = t.match(/^([\d.,]+)\s*Acres?\s+Lot$/i);
                if (lotM && !out.lotSize) out.lotSize = `${lotM[1]} Acres`;
                const yearM = t.match(/^Built\s+in\s+(\d{4})$/i);
                if (yearM && !out.yearBuilt) out.yearBuilt = yearM[1];
                if (!out.propertyType && /^(Single Family|Multi Family|Condo|Townhouse|Manufactured|Mobile|Apartment|Land|Vacant)/i.test(t)) {
                    out.propertyType = t;
                }
                const ppsfM = t.match(/\$([\d,]+)\s*\/\s*sqft/i);
                if (ppsfM && !out.pricePerSqft) out.pricePerSqft = Number(ppsfM[1].replace(/,/g, ''));
            }
        }

        // Facts & features fallback
        const fm = {};
        $$('[data-testid="fact-category"] li').forEach(li => {
            const t = clean(li.textContent);
            const i = t.indexOf(': ');
            if (i > 0) {
                const k = t.slice(0, i);
                if (!(k in fm)) fm[k] = t.slice(i + 2);
            }
        });
        if (!out.propertyType && (fm['Home type'] || fm['Property subtype'])) out.propertyType = fm['Home type'] || fm['Property subtype'];
        if (!out.yearBuilt && fm['Year built']) out.yearBuilt = fm['Year built'];
        if (!out.lotSize && fm['Size']) out.lotSize = fm['Size'];
        if (!out.pricePerSqft && fm['Price per square foot']) out.pricePerSqft = num(fm['Price per square foot']);
        if (!out.hoa) {
            if (fm['HOA fee'] || fm['HOA fee frequency']) out.hoa = fm['HOA fee'] || fm['HOA fee frequency'];
            else out.hoa = 'No / None listed';
        }

        // DESCRIPTION (visible)
        const descEl = $('[data-testid="description"] article') || $('[data-testid="description"]');
        if (descEl) out.description = clean(descEl.textContent) || 'N/A';

        // Agent + MLS (for-sale pages only)
        const la = $('[data-testid="attribution-LISTING_AGENT"]');
        if (la) {
            const parts = Array.from(la.querySelectorAll('span')).map(x => clean(x.textContent).replace(/,$/, '')).filter(Boolean);
            const broker = clean($('[data-testid="attribution-BROKER"]')?.textContent);
            out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
        }
        const mlsInfo = clean($('[role="contentinfo"][aria-label="MLS information"]')?.textContent);
        if (mlsInfo) {
            const m = mlsInfo.match(/Source:\s*(.+?),\s*MLS#:\s*([A-Za-z0-9-]+)/);
            if (m) out.mls = `${m[2]} - ${clean(m[1])}`;
        }

        // PAGE TEXT formatter
        const formatPageText = () => {
            const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','TEMPLATE','BUTTON','SELECT','INPUT','TEXTAREA','HEAD','LINK','META','PATH','IMG','VIDEO','AUDIO','CANVAS','OBJECT','EMBED']);
            const SKIP_IDS = new Set(['pfs-nav-wrapper','page-header-container','sw-container','skip-topnav-target','__PFS_TOPNAV_DATA__','hdp-srp-split-page-frame-nav-styles','with-product-nav-styles','hdp-srp-split-no-search-layout-styles']);
            const SKIP_TESTIDS = new Set(['topnav','back-link','desktop-action-bar','close-lightbox-button']);
            const INLINE = new Set(['A','SPAN','B','STRONG','EM','I','U','SMALL','LABEL','SUP','SUB','ABBR','TIME','MARK','CODE','FONT','BR']);
            const lines = [];
            let buf = '';
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
                if (/^H[1-6]$/.test(tag)) {
                    flush();
                    const t = clean(n.textContent);
                    if (t) { lines.push(''); lines.push('## ' + t); }
                    return;
                }
                if (tag === 'TR') {
                    flush();
                    const cells = Array.from(n.children)
                        .filter(c => /^(TD|TH)$/i.test(c.tagName))
                        .map(c => clean(c.textContent)).filter(Boolean);
                    if (cells.length) lines.push(cells.join(' | '));
                    return;
                }
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

    // ---------- 6) Parse history table (now mounted after scroll+wait) ----------
    let domRows = [];
    try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}

    if (!domRows.length) {
        // one more scroll + short wait as last resort
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => /price\s*history/i.test(x.textContent || ''));
            if (h) h.scrollIntoView({ block: 'center' });
        }).catch(() => {});
        await delay(2000);
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
                if (m) { data.mls = `${m[2]} - ${m[1].trim()}`; break; }
            }
        }
    }

    // ---------- 7) Description JSON-LD fallback (only for description) ----------
    if (!data.description || data.description === 'N/A') {
        try {
            const ldDesc = await page.evaluate(() => {
                for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
                    try {
                        const j = JSON.parse(sc.textContent);
                        if (j && j.description && String(j.description).length > 40) {
                            return String(j.description).replace(/\r/g, '').trim();
                        }
                    } catch (e) {}
                }
                return "";
            });
            if (ldDesc) data.description = ldDesc;
            else data.description = 'N/A';
        } catch (e) {
            data.description = data.description || 'N/A';
        }
    }

    // ---------- 8) Facts & Features section ----------
    data.factsFeaturesText = "";
    try {
        const facts = await page.evaluate(() => {
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
        });
        data.factsFeaturesText = facts || "";
    } catch (e) {}

    return data;
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log("🚀 Starting Stealth Scraper V11 (scroll → wait 2s → scrape)...");

    const setOutput = (hasMore, blocked) => {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`);
        }
    };

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    if (sheet.columnCount < REQUIRED_COLS) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    }
    await sheet.loadCells();
    console.log(`📊 Sheet: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    const setCell = (r, c, v) => { if (c < sheet.columnCount) sheet.getCell(r, c).value = safeCell(v); };

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1400,900',
        ],
    });

    let scrapeCount = 0, skipped = 0;
    let rowsRemaining = false, ipFlagged = false, stoppedEarly = false;
    let blockStreak = 0, consecutiveErrors = 0, dirty = 0;

    const flush = async () => { if (dirty > 0) { await saveWithRetry(sheet); dirty = 0; } };

    // ---- Headings
    try {
        HEADERS.forEach((title, i) => {
            const col = HEADER_START_COL + i;
            if (col >= sheet.columnCount) return;
            const cell = sheet.getCell(0, col);
            if (OVERWRITE_HEADERS || !cell.value) {
                cell.value = title;
                try { cell.textFormat = { bold: true }; } catch (e) {}
                dirty++;
            }
        });
        if (dirty) console.log(`🏷️ Added/updated ${dirty} heading cells`);
    } catch (e) {
        console.warn(`⚠️ Could not write headings: ${e.message}`);
    }

    try {
        for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
            if (Date.now() - startTime > MAX_RUNTIME_MS) { rowsRemaining = true; break; }
            if (scrapeCount >= MAX_ROWS_PER_RUN) { rowsRemaining = true; break; }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.log(`🛑 ${MAX_CONSECUTIVE_ERRORS} errors in a row — ending batch.`);
                stoppedEarly = true; break;
            }

            const url = sheet.getCell(rowIndex, 0).value;
            const status = sheet.getCell(rowIndex, 17).value || "";

            if (!url || !String(url).includes("zillow.com") || String(status).includes("✅")) continue;
            if (isSkipStatus(status) && !RETRY_BLOCKED) { skipped++; continue; }

            const actualRow = rowIndex + 1;
            console.log(`🕵️ Row ${actualRow}: ${url}`);

            const page = await browser.newPage();
            try {
                // Realistic viewport so lazy sections mount like a real user
                await page.setViewport({ width: 1400, height: 900 });

                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {});
                    else req.continue().catch(() => {});
                });

                await delay(jitter(500, 1000));
                await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });

                // wait for basic property content to hydrate
                await page.waitForSelector(
                    '[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"]',
                    { timeout: 12000 }
                ).catch(() => {});
                await delay(1000);

                const title = await page.title();
                const hasNext = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
                const blockedTitle = /pardon our interruption|robot check|access denied/i.test(title);

                if (blockedTitle || !hasNext) {
                    console.log(`❌ BLOCKED on Row ${actualRow} — marked and skipped`);
                    setCell(rowIndex, 17, blockedTitle ? "❌ BLOCKED (skipped)" : "🚫 No data - blocked? (skipped)");
                    dirty++;
                    blockStreak++;
                    if (blockStreak >= MAX_BLOCK_STREAK) {
                        console.log(`🛑 ${blockStreak} blocks in a row — ending batch; next batch continues with the next rows.`);
                        ipFlagged = true; rowsRemaining = true;
                    }
                } else {
                    const d = await extractPageData(page, String(url));
                    if (!(d.price || d.fullAddress || d.description)) {
                        setCell(rowIndex, 17, "⚠️ Empty parse (skipped)");
                        dirty++;
                        consecutiveErrors++;
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
                        scrapeCount++;
                        blockStreak = 0;
                        consecutiveErrors = 0;
                        console.log(`✔️ ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${d.priceHistoryText ? 'YES (' + d.priceHistoryText.split('\n').length + ' rows)' : 'NO'} | 🏷️ MLS: ${d.mls || '—'}`);
                        console.log(`   📅 Listed: ${d.listedForSale || '—'} | 📅 Sold: ${d.soldOn || '—'} | 🛏️ ${d.beds || '—'} bd / ${d.baths || '—'} ba / ${d.sqft || '—'} sqft | 📐 ${d.lotSize || '—'} | 🏗️ ${d.yearBuilt || '—'} | 🏠 ${d.propertyType || '—'}`);
                        console.log(`   📄 pageText: ${d.pageText ? d.pageText.length : 0} chars | desc: ${d.description ? d.description.length : 0} chars`);
                    }
                }
            } catch (e) {
                console.error(`🛑 Error on Row ${actualRow}: ${e.message}`);
                setCell(rowIndex, 17, "🛑 Error: " + e.message);
                dirty++;
                consecutiveErrors++;
            } finally {
                await page.close().catch(() => {});
            }

            if (ipFlagged) break;
            if (dirty >= FLUSH_BATCH_SIZE) {
                console.log(`📦 Saving batch to Google Sheets...`);
                await flush();
            }
        }
    } finally {
        try { await flush(); } catch (e) { console.error(`⚠️ Final save failed: ${e.message}`); }
        await browser.close().catch(() => {});
    }

    if (skipped) console.log(`⏭️ Skipped ${skipped} rows already marked blocked/error`);
    const hasMore = rowsRemaining || stoppedEarly;
    setOutput(hasMore, ipFlagged && scrapeCount === 0);
    console.log(hasMore ? "🔄 More rows remain — next batch will be triggered." : "🎉 Sheet fully processed!");
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
