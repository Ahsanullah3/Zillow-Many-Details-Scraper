const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG  (same lightweight approach as the working script)
// =========================================================
const MAX_ROWS_PER_RUN = 30;        // successful rows per batch (blocked rows don't count)
const FLUSH_BATCH_SIZE = 8;
const REQUIRED_COLS = 34;
const MAX_BLOCK_STREAK = 3;         // blocks in a row => end batch, next batch continues with NEXT rows
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_RUNTIME_MS = 12 * 60 * 1000;
// Optional: also read the visible price-history table if the embedded data has none.
// Needs scrolling/lazy requests, so it's OFF by default (set PRICE_HISTORY_DOM=1 to try).
const PRICE_HISTORY_DOM = process.env.PRICE_HISTORY_DOM === '1';
// Rows marked blocked/error are skipped in every batch. RETRY_BLOCKED=1 retries them once.
const RETRY_BLOCKED = process.env.RETRY_BLOCKED === '1';
const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse/i.test(String(st || ''));

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

const MAX_CELL_LEN = 49000;
const safeCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
};

// =========================================================
// GOOGLE API RETRY (500 error fix)
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
// OPTIONAL: price history from the rendered table
// =========================================================
async function historyFromDOM(page) {
    try {
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => (x.innerText || '').toLowerCase().includes('price history'));
            if (h) h.scrollIntoView({ block: 'center' });
        });
        await delay(2000);
        return await page.evaluate(() => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const h = Array.from(document.querySelectorAll('h2,h3'))
                .find(x => clean(x.innerText).toLowerCase().includes('price history'));
            if (!h) return { text: '', listed: '', sold: '' };
            let node = h, table = null;
            for (let i = 0; i < 6 && node; i++) {
                node = node.parentElement;
                if (!node) break;
                table = node.querySelector('table');
                if (table) break;
            }
            if (!table) return { text: '', listed: '', sold: '' };
            const lines = []; let listed = '', sold = '';
            for (const tr of table.querySelectorAll('tr')) {
                const cells = Array.from(tr.querySelectorAll('th,td')).map(c => clean(c.innerText)).filter(Boolean);
                if (!cells.length) continue;
                lines.push(cells.join(' | '));
                if (cells.length >= 3) {
                    const ev = cells[1].toLowerCase();
                    if (ev.includes('listed for sale') && !listed) listed = `${cells[0]} (${cells[2]})`;
                    if (ev.includes('sold') && !sold) sold = cells[0];
                }
            }
            return { text: lines.join('\n'), listed, sold };
        });
    } catch (e) {
        return { text: '', listed: '', sold: '' };
    }
}

// =========================================================
// EXTRACT (reads embedded Next.js state, like the working script)
// =========================================================
async function extractPageData(page, originalUrl) {
    const data = await page.evaluate(() => {
        const out = {
            price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
            agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
            pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
            listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
            hoa: "", priceHistoryText: "", pageText: ""
        };

        const fmtType = (raw) => !raw ? "" : String(raw).replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        const money = (n) => (typeof n === 'number') ? '$' + n.toLocaleString('en-US') : (n || '');

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

            // Price history straight from the embedded data (no scrolling / extra requests)
            if (Array.isArray(p.priceHistory) && p.priceHistory.length) {
                out.priceHistoryText = p.priceHistory
                    .map(h => [h.date, h.event, money(h.price)].filter(Boolean).join(' | ')).join('\n');
                for (const h of p.priceHistory) {
                    const ev = String(h.event || '').toLowerCase();
                    if (ev.includes('listed for sale') && !out.listedForSale) out.listedForSale = `${h.date} (${money(h.price)})`;
                    if (ev.includes('sold') && !out.soldOn) out.soldOn = h.date || "";
                }
            }
        } else {
            // ---- Rental building page (fallback, like the working script)
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

        out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(", ");
        try { out.pageText = document.body.innerText || ""; } catch (e) {}
        return out;
    });

    if (!data.canonicalUrl) data.canonicalUrl = originalUrl;

    if (PRICE_HISTORY_DOM && !data.priceHistoryText) {
        const h = await historyFromDOM(page);
        data.priceHistoryText = h.text;
        if (h.listed && !data.listedForSale) data.listedForSale = h.listed;
        if (h.sold && !data.soldOn) data.soldOn = h.sold;
    }

    // Facts & Features (best-effort, from the HTML already loaded)
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
    console.log("🚀 Starting Stealth Scraper V7 (lightweight, skip-blocked)...");

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

    // Same launch as the working script: bundled Chrome, headless new, minimal args
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    let scrapeCount = 0, skipped = 0;
    let rowsRemaining = false, ipFlagged = false, stoppedEarly = false;
    let blockStreak = 0, consecutiveErrors = 0, dirty = 0;

    const flush = async () => { if (dirty > 0) { await saveWithRetry(sheet); dirty = 0; } };

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

            // New page per row, request blocking, short delay — same as the working script
            const page = await browser.newPage();
            try {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {});
                    else req.continue().catch(() => {});
                });

                await delay(jitter(500, 1000));
                await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });

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
                        console.log(`✔️ ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${d.priceHistoryText ? 'YES' : 'NO'}`);
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
    // blocked=true only when this batch made zero progress because of blocks
    setOutput(hasMore, ipFlagged && scrapeCount === 0);
    console.log(hasMore ? "🔄 More rows remain — next batch will be triggered." : "🎉 Sheet fully processed!");
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
