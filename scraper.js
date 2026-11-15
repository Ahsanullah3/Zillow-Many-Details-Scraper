const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG
// =========================================================
const MAX_RUNTIME_MS = 330000;
const MIN_SLEEP_MS = 8000;            // slower = far fewer blocks
const MAX_SLEEP_MS = 20000;
const MAX_ROWS_PER_RUN = 15;
const REQUIRED_COLS = 34;
const FLUSH_BATCH_SIZE = 5;
const MAX_CONSECUTIVE_ERRORS = 3;     // stop run if things keep failing
const BLOCKED_RESOURCES = ['image', 'media']; // keep CSS/fonts so traffic looks real

// Optional env vars:
//   PUPPETEER_EXECUTABLE_PATH : Edge/Chrome path (falls back to bundled Chromium)
//   USER_DATA_DIR             : persistent profile folder (keeps cookies between runs)
//   HEADFUL=1                 : run with a visible window (best on a local/home PC)
const USER_DATA_DIR = process.env.USER_DATA_DIR || './browser-profile';
const HEADFUL = process.env.HEADFUL === '1';

// =========================================================
// HELPERS
// =========================================================
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

const MAX_CELL_LEN = 49000;
const safeCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
};

// =========================================================
// BROWSER LAUNCH
// =========================================================
async function launchBrowser() {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (execPath) console.log(`🌐 Using browser: ${execPath}`);
    else console.log('🌐 Using bundled Chromium');

    return puppeteer.launch({
        headless: HEADFUL ? false : 'new',
        ...(execPath ? { executablePath: execPath } : {}),
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--lang=en-US,en',
            '--window-size=1366,768',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null,
    });
}

// =========================================================
// PAGE SETUP (created ONCE and reused for every row)
// =========================================================
async function preparePage(browser) {
    const page = await browser.newPage();

    // Use the browser's REAL user agent (only remove the "Headless" tag).
    // A hardcoded Windows UA on a Linux runner is a classic detection signal.
    const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
    await page.setUserAgent(ua);
    await page.setViewport({ width: jitter(1366, 1600), height: jitter(768, 1000) });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (BLOCKED_RESOURCES.includes(req.resourceType())) req.abort().catch(() => {});
        else req.continue().catch(() => {});
    });

    // Stealth plugin already handles webdriver/plugins/languages/chrome.
    // Manual overrides were removed because they create inconsistencies.
    return page;
}

// =========================================================
// HUMAN-LIKE NAVIGATION
// =========================================================
async function humanNavigate(page, url) {
    await delay(jitter(1500, 3500));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    try { await page.mouse.move(jitter(150, 900), jitter(100, 700), { steps: jitter(5, 15) }); } catch (_) {}
    try { await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 500)); } catch (_) {}
    await delay(jitter(1200, 2500));
}

// =========================================================
// BLOCK DETECTION
// =========================================================
function isBlocked(title, bodyText) {
    const t = (title || '').toLowerCase();
    const b = (bodyText || '').toLowerCase();
    return (
        t.includes('pardon our interruption') ||
        t.includes('robot check') ||
        t.includes('access denied') ||
        t.includes('captcha') ||
        b.includes('pardon our interruption') ||
        b.includes('press & hold') ||
        b.includes('press and hold') ||
        b.includes('verify you are a human')
    );
}

async function checkBlocked(page) {
    const title = await page.title().catch(() => '');
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 600)).catch(() => '');
    return isBlocked(title, body);
}

// =========================================================
// EXTRACT HISTORY FROM RENDERED DOM
// =========================================================
async function extractHistoryFromDOM(page) {
    const result = { priceHistoryText: "", listedForSale: "", soldOn: "" };

    try {
        await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('h2, h3'));
            const ph = headers.find(h => (h.innerText || '').toLowerCase().includes('price history'));
            if (ph) ph.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(2500);

        // Wait briefly for the table instead of assuming it's there
        await page.waitForSelector('table', { timeout: 4000 }).catch(() => {});

        const data = await page.evaluate(() => {
            const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const headers = Array.from(document.querySelectorAll('h2, h3'));
            const phHeader =
                headers.find(h => cleanText(h.innerText).toLowerCase() === 'price history') ||
                headers.find(h => cleanText(h.innerText).toLowerCase().includes('price history'));
            if (!phHeader) return { lines: [], listedForSale: '', soldOn: '' };

            let node = phHeader;
            let table = null;
            for (let i = 0; i < 6 && node; i++) {
                node = node.parentElement;
                if (!node) break;
                table = node.querySelector('table');
                if (table) break;
            }
            if (!table) return { lines: [], listedForSale: '', soldOn: '' };

            const rows = Array.from(table.querySelectorAll('tr'));
            const lines = [];
            let listedForSale = '';
            let soldOn = '';

            for (const tr of rows) {
                const cells = Array.from(tr.querySelectorAll('th,td'))
                    .map(c => cleanText(c.innerText)).filter(Boolean);
                if (cells.length) lines.push(cells.join(' | '));

                if (cells.length >= 3) {
                    const date = cells[0];
                    const event = (cells[1] || '').toLowerCase();
                    const price = cells[2];
                    if (event.includes('listed for sale') && !listedForSale) listedForSale = `${date} (${price})`;
                    if (event.includes('sold') && !soldOn) soldOn = date;
                }
            }
            return { lines, listedForSale, soldOn };
        });

        result.priceHistoryText = data.lines.join('\n');
        result.listedForSale = data.listedForSale;
        result.soldOn = data.soldOn;

        if (result.priceHistoryText) console.log(`   📊 History from DOM: ${data.lines.length} rows`);
    } catch (e) {
        console.log(`   ⚠️ DOM history: ${e.message}`);
    }

    return result;
}

// =========================================================
// EXTRACT PAGE DATA
// =========================================================
async function extractPageData(page, originalUrl) {
    const out = {
        price: "", street: "", city: "", state: "", zipcode: "",
        fullAddress: "", agentDetails: "", soldPrice: "",
        canonicalUrl: "", description: "", pricePerSqft: "",
        beds: "", baths: "", sqft: "", lotSize: "",
        listedForSale: "", soldOn: "", mls: "", propertyType: "",
        yearBuilt: "", hoa: "", zpid: "",
        priceHistoryText: "", factsFeaturesText: "", pageText: ""
    };

    const html = await page.content();

    const ogMatch = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i);
    if (ogMatch) out.canonicalUrl = ogMatch[1];

    const zpidMatch = originalUrl.match(/\/(\d+)_zpid/);
    if (zpidMatch) out.zpid = zpidMatch[1];

    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (nextMatch) {
        try {
            const json = JSON.parse(nextMatch[1]);
            const rawCache = json?.props?.pageProps?.componentProps?.gdpClientCache;
            if (rawCache) {
                const parsed = typeof rawCache === 'string' ? JSON.parse(rawCache) : rawCache;
                const key = Object.keys(parsed).find(k => parsed[k]?.property);
                const p = key ? parsed[key]?.property : null;
                if (p) {
                    out.price = p.price || "";
                    out.street = p.address?.streetAddress || p.streetAddress || "";
                    out.city = p.address?.city || p.city || "";
                    out.state = p.address?.state || p.state || "";
                    out.zipcode = p.address?.zipcode || p.zipcode || "";
                    out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(", ");
                    out.beds = p.bedrooms ?? p.resoFacts?.bedrooms ?? "";
                    out.baths = p.bathrooms ?? p.resoFacts?.bathrooms ?? "";
                    out.sqft = p.livingAreaValue ?? p.livingArea ?? p.resoFacts?.livingArea ?? "";
                    if (p.resoFacts?.pricePerSquareFoot) out.pricePerSqft = p.resoFacts.pricePerSquareFoot;
                    else if (out.price && out.sqft && Number(out.sqft) > 0) {
                        out.pricePerSqft = Math.round(Number(out.price) / Number(out.sqft));
                    }
                    const lotStr = p.resoFacts?.lotSize || "";
                    const lotAcres = p.lotAreaValue || "";
                    const lotUnits = p.lotAreaUnits || "";
                    out.lotSize = lotStr || (lotAcres ? `${lotAcres} ${lotUnits}`.trim() : "");
                    if (p.attributionInfo) {
                        out.agentDetails = [p.attributionInfo.agentName, p.attributionInfo.brokerName, p.attributionInfo.agentPhoneNumber].filter(Boolean).join(" | ");
                    }
                    out.soldPrice = p.lastSoldPrice || "";
                    out.description = p.description || p.homeDescription || "N/A";
                    out.mls = [p.attributionInfo?.mlsId, p.attributionInfo?.mlsName].filter(Boolean).join(" - ");
                    out.propertyType = p.homeType || p.resoFacts?.homeType || p.propertyTypeDimension || "";
                    out.yearBuilt = p.yearBuilt || p.resoFacts?.yearBuilt || "";
                    if (p.monthlyHoaFee) out.hoa = `$${p.monthlyHoaFee}/mo`;
                    else if (p.resoFacts?.hoaFeeTotal) out.hoa = p.resoFacts.hoaFeeTotal;
                    else out.hoa = "No / None listed";
                }
            }
        } catch (e) {
            console.log(`   ⚠️ __NEXT_DATA__ parse: ${e.message}`);
        }
    }

    const history = await extractHistoryFromDOM(page);
    out.priceHistoryText = history.priceHistoryText;
    if (history.listedForSale && !out.listedForSale) out.listedForSale = history.listedForSale;
    if (history.soldOn && !out.soldOn) out.soldOn = history.soldOn;

    // Facts & Features (best-effort)
    try {
        const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const ffSection = html.match(/Facts &amp; Features([\s\S]{0,50000})/i);
        if (ffSection) {
            const text = ffSection[1]
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, '\n');
            out.factsFeaturesText = text.split('\n').map(l => cleanText(l)).filter(Boolean).join("\n").slice(0, 45000);
        }
    } catch (e) {}

    try {
        out.pageText = await page.evaluate(() => document.body.innerText || "");
    } catch (e) {}

    return out;
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log("🚀 Starting Scraper V17...");

    const setOutput = (hasMore) => {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\n`);
        }
    };

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    if (sheet.columnCount < REQUIRED_COLS) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    }
    await sheet.loadCells();
    console.log(`📊 Sheet: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    const setCell = (r, c, v) => {
        if (c >= sheet.columnCount) return;
        sheet.getCell(r, c).value = safeCell(v);
    };

    const browser = await launchBrowser();
    let page;
    let scrapeCount = 0;
    let rowsRemaining = false;
    let ipBlocked = false;
    let consecutiveErrors = 0;
    let dirty = 0;

    const flush = async () => {
        if (dirty > 0) {
            await sheet.saveUpdatedCells();
            dirty = 0;
        }
    };

    try {
        page = await preparePage(browser);

        // Warm-up on the SAME page/session
        try {
            console.log("🍪 Warming up...");
            await page.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await delay(jitter(3000, 5000));
            if (await checkBlocked(page)) {
                console.log("🛑 Warm-up blocked (IP likely flagged). Aborting.");
                setOutput(false);
                return;
            }
            console.log("🍪 Warm-up done.");
        } catch (e) {
            console.warn(`⚠️ Warm-up: ${e.message}`);
        }

        for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
            if (ipBlocked) break;
            if (Date.now() - startTime > MAX_RUNTIME_MS) { rowsRemaining = true; break; }
            if (scrapeCount >= MAX_ROWS_PER_RUN) { rowsRemaining = true; break; }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.log(`🛑 ${MAX_CONSECUTIVE_ERRORS} errors in a row — stopping run.`);
                break;
            }

            const originalUrl = sheet.getCell(rowIndex, 0).value;
            const status = sheet.getCell(rowIndex, 17).value || "";

            if (!originalUrl || !String(originalUrl).includes("zillow.com") || String(status).includes("✅")) continue;

            const actualRowNumber = rowIndex + 1;
            console.log(`🕵️ Row ${actualRowNumber}: ${originalUrl}`);

            try {
                await humanNavigate(page, String(originalUrl));

                if (await checkBlocked(page)) {
                    console.log(`🛑 BLOCKED on Row ${actualRowNumber} — stopping.`);
                    setCell(rowIndex, 17, "❌ BLOCKED");
                    dirty++;
                    ipBlocked = true;
                    rowsRemaining = false;
                    break;
                }

                const hasNextData = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
                if (!hasNextData) {
                    console.log(`   ⚠️ No __NEXT_DATA__ — page may be blocked or wrong template`);
                    setCell(rowIndex, 17, "🚫 No data (blocked?)");
                    dirty++;
                    ipBlocked = true;
                    rowsRemaining = false;
                    break;
                }

                setCell(rowIndex, 17, "Parsing + History...");
                const data = await extractPageData(page, String(originalUrl));
                const finalUrl = data.canonicalUrl || originalUrl;

                // Don't mark Done if nothing useful was extracted
                const gotData = data.price || data.fullAddress || data.description;
                if (!gotData) {
                    setCell(rowIndex, 17, "⚠️ Empty parse");
                    dirty++;
                    consecutiveErrors++;
                    continue;
                }

                setCell(rowIndex, 9,  data.price);
                setCell(rowIndex, 10, data.street);
                setCell(rowIndex, 11, data.city);
                setCell(rowIndex, 12, data.state);
                setCell(rowIndex, 13, data.zipcode);
                setCell(rowIndex, 14, finalUrl);
                setCell(rowIndex, 15, data.agentDetails);
                setCell(rowIndex, 16, data.soldPrice);
                setCell(rowIndex, 17, "✅ Done");
                setCell(rowIndex, 18, data.description);
                setCell(rowIndex, 19, data.fullAddress);
                setCell(rowIndex, 20, data.pricePerSqft);
                setCell(rowIndex, 21, data.beds);
                setCell(rowIndex, 22, data.baths);
                setCell(rowIndex, 23, data.sqft);
                setCell(rowIndex, 24, data.lotSize);
                setCell(rowIndex, 25, data.listedForSale);
                setCell(rowIndex, 26, data.soldOn);
                setCell(rowIndex, 27, data.mls);
                setCell(rowIndex, 28, data.propertyType);
                setCell(rowIndex, 29, data.yearBuilt);
                setCell(rowIndex, 30, data.hoa);
                setCell(rowIndex, 31, data.priceHistoryText);
                setCell(rowIndex, 32, data.factsFeaturesText);
                setCell(rowIndex, 33, data.pageText);

                dirty++;
                scrapeCount++;
                consecutiveErrors = 0;
                console.log(`   ✔️ ${data.fullAddress || '?'} | 💰 ${data.price || '?'} | 📊 Hist: ${data.priceHistoryText ? 'YES' : 'NO'}`);

            } catch (e) {
                console.error(`   🛑 Error: ${e.message}`);
                setCell(rowIndex, 17, "🛑 Error: " + e.message);
                dirty++;
                consecutiveErrors++;

                // If the page itself died, open a fresh one
                if (page.isClosed()) page = await preparePage(browser);
            }

            if (dirty >= FLUSH_BATCH_SIZE) await flush();

            // Longer, randomized pause between listings
            await delay(jitter(MIN_SLEEP_MS, MAX_SLEEP_MS));
        }
    } finally {
        // Always save pending changes (including BLOCKED status) before exiting
        try { await flush(); } catch (e) { console.error(`⚠️ Final save failed: ${e.message}`); }
        await browser.close().catch(() => {});
    }

    setOutput(rowsRemaining);
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
