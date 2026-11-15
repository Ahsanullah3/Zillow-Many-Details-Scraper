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
const PRICE_HISTORY_DOM = process.env.PRICE_HISTORY_DOM === '1';
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
    // FIX: give the price-history table a chance to render before we format page text
    await page.waitForSelector('[data-testid="date-info"]', { timeout: 4000 }).catch(() => {});

    const data = await page.evaluate(() => {
        const out = {
            price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
            agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
            pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
            listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
            hoa: "", priceHistoryText: "", pageText: "", embeddedHistory: []
        };

        const fmtType = (raw) => !raw ? "" : String(raw).replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        const money = (n) => (typeof n === 'number') ? '$' + n.toLocaleString('en-US') : (n || '');

        // -----------------------------------------------------
        // FIXED formatPageText: skips nav/chrome, falls back to innerText
        // -----------------------------------------------------
        const formatPageText = () => {
            const SKIP = new Set([
                'SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','TEMPLATE',
                'BUTTON','SELECT','INPUT','TEXTAREA','HEAD','LINK','META','PATH','IMG',
                'VIDEO','AUDIO','CANVAS','OBJECT','EMBED'
            ]);
            const SKIP_IDS = new Set([
                'pfs-nav-wrapper','page-header-container','sw-container',
                'skip-topnav-target','__PFS_TOPNAV_DATA__',
                'hdp-srp-split-page-frame-nav-styles',
                'with-product-nav-styles','hdp-srp-split-no-search-layout-styles'
            ]);
            const SKIP_TESTIDS = new Set([
                'topnav','back-link','desktop-action-bar','close-lightbox-button'
            ]);
            const INLINE = new Set([
                'A','SPAN','B','STRONG','EM','I','U','SMALL','LABEL',
                'SUP','SUB','ABBR','TIME','MARK','CODE','FONT','BR'
            ]);
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const lines = [];
            let buf = '';
            const flush = (prefix = '') => {
                const t = clean(buf);
                buf = '';
                if (t) lines.push(prefix + t);
            };

            const isChrome = (node) => {
                if (node.id && SKIP_IDS.has(node.id)) return true;
                const tid = node.getAttribute && node.getAttribute('data-testid');
                if (tid && SKIP_TESTIDS.has(tid)) return true;
                const cls = (node.className && String(node.className)) || '';
                if (/\b(topnav|znav|pfs-nav|hdp-action-bar|layout-action-bar|with-product-nav__product-nav)\b/i.test(cls)) return true;
                return false;
            };

            const walk = (node) => {
                if (node.nodeType === 3) { buf += ' ' + node.nodeValue; return; }
                if (node.nodeType !== 1) return;
                const tag = node.tagName.toUpperCase();
                if (SKIP.has(tag)) return;
                if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;
                if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) return;
                if (isChrome(node)) return;

                if (/^H[1-6]$/.test(tag)) {
                    flush();
                    const t = clean(node.textContent);
                    if (t) { lines.push(''); lines.push('## ' + t); }
                    return;
                }
                if (tag === 'TR') {
                    flush();
                    const cells = Array.from(node.children)
                        .filter(c => /^(TD|TH)$/i.test(c.tagName))
                        .map(c => clean(c.textContent)).filter(Boolean);
                    if (cells.length) lines.push(cells.join(' | '));
                    return;
                }
                if (tag === 'BR') { flush(); return; }
                if (tag === 'LI') {
                    flush();
                    for (const c of node.childNodes) walk(c);
                    flush('- ');
                    return;
                }
                const inline = INLINE.has(tag);
                if (!inline) flush();
                for (const c of node.childNodes) walk(c);
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

            // Fallback: if the SPA shell hasn't hydrated, formatted text will be tiny.
            if (formatted.length < 800) {
                const fallback = (document.body.innerText || '')
                    .replace(/\r/g, '')
                    .replace(/[ \t]+\n/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                return head.concat(['', fallback]).join('\n').trim();
            }
            return formatted;
        };

        out.canonicalUrl = document.querySelector('meta[property="og:url"]')?.content || "";

        let json = null;
        try { json = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.innerText || 'null'); } catch (e) {}
        const cp = json?.props?.pageProps?.componentProps;

        // ---- Home detail page
        let p = null;
        try {
            const raw = cp?.gdpClientCache;
            if (raw) {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const key = Object.keys(parsed).find(k => parsed[k]?.property);
                p = key ? parsed[key].property : null;
            }
        } catch (e) {}

        if (p) {
            out.price = p.price || "";
            out.street = p.address?.streetAddress || p.streetAddress || "";
            out.city = p.address?.city || p.city || "";
            out.state = p.address?.state || p.state || "";
            out.zipcode = p.address?.zipcode || p.zipcode || "";
            out.beds = p.bedrooms ?? p.resoFacts?.bedrooms ?? "";
            out.baths = p.bathrooms ?? p.resoFacts?.bathrooms ?? "";
            out.sqft = p.livingAreaValue ?? p.livingArea ?? p.resoFacts?.livingArea ?? "";
            if (p.resoFacts?.pricePerSquareFoot) out.pricePerSqft = p.resoFacts.pricePerSquareFoot;
            else if (out.price && out.sqft && Number(out.sqft) > 0) out.pricePerSqft = Math.round(Number(out.price) / Number(out.sqft));
            const lotStr = p.resoFacts?.lotSize || "";
            const lotVal = p.lotAreaValue || "";
            out.lotSize = lotStr || (lotVal ? `${lotVal} ${p.lotAreaUnits || ''}`.trim() : "");
            if (p.attributionInfo) {
                out.agentDetails = [p.attributionInfo.agentName, p.attributionInfo.brokerName, p.attributionInfo.agentPhoneNumber].filter(Boolean).join(" | ");
            }
            out.soldPrice = p.lastSoldPrice || "";
            out.description = p.description || p.homeDescription || "N/A";
            out.mls = [p.attributionInfo?.mlsId, p.attributionInfo?.mlsName].filter(Boolean).join(" - ");
            out.propertyType = fmtType(p.homeType || p.resoFacts?.homeType || p.propertyTypeDimension);
            out.yearBuilt = p.yearBuilt || p.resoFacts?.yearBuilt || "";
            if (p.monthlyHoaFee) out.hoa = `$${p.monthlyHoaFee}/mo`;
            else if (p.resoFacts?.hoaFeeTotal) out.hoa = p.resoFacts.hoaFeeTotal;
            else out.hoa = "No / None listed";

            if (Array.isArray(p.priceHistory)) {
                const fmtDate = (d) => {
                    if (typeof d === 'number') { const x = new Date(d); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; }
                    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
                    return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(d || '');
                };
                out.embeddedHistory = p.priceHistory.map(h => ({
                    date: fmtDate(h.date),
                    event: h.event || '',
                    price: money(h.price),
                    change: (typeof h.priceChangeRate === 'number' && h.priceChangeRate !== 0) ? `${(h.priceChangeRate * 100).toFixed(1)}%` : '',
                    ppsf: h.pricePerSquareFoot ? `$${Math.round(h.pricePerSquareFoot)}/sqft` : '',
                    source: h.source ? `Source: ${h.source}` : ''
                }));
            }
        } else {
            const b = cp?.initialReduxState?.gdp?.building;
            if (b) {
                out.street = b.streetAddress || "";
                out.city = b.city || "";
                out.state = b.state || "";
                out.zipcode = b.zipcode || "";
                out.description = b.description || "";
                out.propertyType = "Apartment";
            }
        }

        // ---- DOM / JSON-LD fallback for SOLD & off-market pages
        try {
            const clean = (x) => (x || '').replace(/\s+/g, ' ').trim();
            const num = (x) => { const m = String(x || '').replace(/,/g, '').match(/[\d.]+/); return m ? Number(m[0]) : ''; };
            const empty = (v) => v === '' || v === null || v === undefined || v === 'N/A';
            const $ = (sel) => document.querySelector(sel);

            let ld = null;
            for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    const j = JSON.parse(sc.textContent);
                    if ([].concat(j['@type'] || []).includes('RealEstateListing') || j.offers) { ld = j; break; }
                } catch (e) {}
            }
            const item = ld?.offers?.itemOffered;
            const addr = item?.address;

            if (empty(out.street))  out.street  = addr?.streetAddress || '';
            if (empty(out.city))    out.city    = addr?.addressLocality || '';
            if (empty(out.state))   out.state   = addr?.addressRegion || '';
            if (empty(out.zipcode)) out.zipcode = addr?.postalCode || '';
            if (empty(out.street)) {
                const parts = clean($('h1')?.textContent).split(',').map(clean);
                if (parts.length >= 3) {
                    out.street = parts[0]; out.city = parts[1];
                    const m = parts[2].match(/^([A-Z]{2})\s+(\d{5})/);
                    if (m) { out.state = m[1]; out.zipcode = m[2]; }
                }
            }
            if (empty(out.canonicalUrl)) out.canonicalUrl = ld?.url || '';

            if (empty(out.price)) out.price = ld?.offers?.price || num($('[data-testid="price"]')?.textContent);
            if (empty(out.soldPrice)) {
                const m = clean($('[data-testid="gallery-status-pill"]')?.textContent).match(/Sold for \$([\d,]+)/i);
                if (m) out.soldPrice = Number(m[1].replace(/,/g, ''));
            }

            const head = {};
            document.querySelectorAll('[data-testid="bed-bath-sqft-fact-container"]').forEach((c) => {
                const sp = c.querySelectorAll('span');
                if (sp.length >= 2) head[clean(sp[1].textContent).toLowerCase()] = clean(sp[0].textContent);
            });
            if (empty(out.beds))  out.beds  = num(head.beds)  || item?.numberOfBedrooms || '';
            if (empty(out.baths)) out.baths = num(head.baths) || '';
            if (empty(out.sqft))  out.sqft  = num(head.sqft)  || item?.floorSize?.value || '';

            if (empty(out.description)) {
                out.description = clean(ld?.description) ? String(ld.description).replace(/\r/g, '').trim()
                    : clean($('[data-testid="description"] article')?.textContent) || 'N/A';
            }

            const fm = {};
            document.querySelectorAll('[data-testid="fact-category"] li').forEach((li) => {
                const t = clean(li.textContent), i = t.indexOf(': ');
                if (i > 0) { const k = t.slice(0, i); if (!(k in fm)) fm[k] = t.slice(i + 2); }
            });
            if (empty(out.propertyType)) out.propertyType = fmtType(fm['Home type'] || fm['Property subtype'] || '');
            if (empty(out.yearBuilt))    out.yearBuilt    = fm['Year built'] || '';
            if (empty(out.lotSize))      out.lotSize      = fm['Size'] || '';
            if (empty(out.pricePerSqft)) {
                out.pricePerSqft = num(fm['Price per square foot']) ||
                    ((out.price && out.sqft && Number(out.sqft) > 0) ? Math.round(Number(out.price) / Number(out.sqft)) : '');
            }
            if (empty(out.hoa)) {
                if (fm['HOA fee'] || fm['HOA fee frequency']) out.hoa = fm['HOA fee'] || fm['HOA fee frequency'];
                else if (/^no$/i.test(fm['Has HOA'] || '')) out.hoa = 'No / None listed';
            }

            if (empty(out.agentDetails)) {
                const la = $('[data-testid="attribution-LISTING_AGENT"]');
                const parts = la ? Array.from(la.querySelectorAll('span')).map((x) => clean(x.textContent).replace(/,$/, '')).filter(Boolean) : [];
                const broker = clean($('[data-testid="attribution-BROKER"]')?.textContent);
                out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
            }
            if (empty(out.mls)) {
                const info = clean($('[role="contentinfo"][aria-label="MLS information"]')?.textContent);
                const m = info.match(/Source:\s*(.+?),\s*MLS#:\s*([A-Za-z0-9-]+)/);
                if (m) out.mls = `${m[2]} - ${clean(m[1])}`;
            }
        } catch (e) {}

        out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(", ");
        try { out.pageText = formatPageText(); } catch (e) { out.pageText = document.body.innerText || ""; }
        return out;
    });

    if (!data.canonicalUrl) data.canonicalUrl = originalUrl;

    // ---- Price history: table + embedded, keep the richer one
    let domRows = [];
    try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
    const embRows = data.embeddedHistory || [];

    if (!domRows.length && !embRows.length) {
        await page.waitForSelector('[data-testid="date-info"]', { timeout: 3000 }).catch(() => {});
        try { domRows = await page.evaluate(parseHistoryRowsInPage); } catch (e) {}
        if (!domRows.length && PRICE_HISTORY_DOM) {
            try {
                await page.evaluate(() => {
                    const h = Array.from(document.querySelectorAll('h2,h3'))
                        .find(x => (x.textContent || '').toLowerCase().includes('price history'));
                    if (h) h.scrollIntoView({ block: 'center' });
                });
                await delay(2000);
                domRows = await page.evaluate(parseHistoryRowsInPage);
            } catch (e) {}
        }
    }

    const rows = domRows.length >= embRows.length ? domRows : embRows;
    delete data.embeddedHistory;
    if (rows.length) {
        data.priceHistoryText = rows.map(r => {
            const priceTxt = r.price + (r.change ? ` (${r.change})` : '');
            return [r.date, r.event, priceTxt, r.ppsf, r.source].filter(Boolean).join(' | ');
        }).join('\n');
        for (const r of rows) {
            const ev = String(r.event || '').toLowerCase();
            if (ev.includes('listed for sale') && !data.listedForSale) data.listedForSale = `${r.date} (${r.price})`;
            if (ev.includes('sold') && !data.soldOn) data.soldOn = r.date;
        }
    }

    // Facts & Features (best-effort, from HTML already loaded)
    data.factsFeaturesText = "";
    try {
        const html = await page.content();
        const m = html.match(/Facts &amp; Features([\s\S]{0,50000})/i);
        if (m) {
            data.factsFeaturesText = m[1]
                .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, '\n').split('\n')
                .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 45000);
        }
    } catch (e) {}

    return data;
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log("🚀 Starting Stealth Scraper V8 (fixed page text)...");

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
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {});
                    else req.continue().catch(() => {});
                });

                await delay(jitter(500, 1000));
                await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });

                // FIX: wait for real property content to hydrate, not just the shell
                await page.waitForSelector(
                    '[data-testid="description"], [data-testid="fact-category"], ' +
                    'script[type="application/ld+json"], [data-testid="gallery-status-pill"]',
                    { timeout: 12000 }
                ).catch(() => {});
                await delay(1500);

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
                        setCell(rowIndex, 33, d.pageText); // column AH
                        dirty++;
                        scrapeCount++;
                        blockStreak = 0;
                        consecutiveErrors = 0;
                        console.log(`✔️ ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${d.priceHistoryText ? 'YES' : 'NO'}`);
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
