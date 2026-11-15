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
const SLEEP_BETWEEN_ROWS_MS = 800;
const MAX_ROWS_PER_RUN = 30;
const REQUIRED_COLS = 34;
const FLUSH_BATCH_SIZE = 8;

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
// BROWSER LAUNCH (EDGE)
// =========================================================
async function launchBrowser() {
    const edgePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!edgePath) throw new Error("PUPPETEER_EXECUTABLE_PATH not set.");

    console.log(`🌐 Using Edge: ${edgePath}`);

    return puppeteer.launch({
        headless: "new",
        executablePath: edgePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-dev-shm-usage',
            '--lang=en-US,en',
            '--window-size=1366,768',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });
}

// =========================================================
// PAGE STEALTH
// =========================================================
async function preparePage(browser) {
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0');
    await page.setViewport({ width: jitter(1366, 1600), height: jitter(768, 1000) });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
        });
        window.chrome = window.chrome || { runtime: {} };
    });

    return page;
}

// =========================================================
// HUMAN NAVIGATION
// =========================================================
async function humanNavigate(page, url) {
    await delay(jitter(1500, 3500));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    try { await page.mouse.move(jitter(150, 900), jitter(100, 700), { steps: jitter(5, 15) }); } catch (_) {}
    try { await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 500)); } catch (_) {}
    await delay(jitter(1200, 2500));
}

// =========================================================
// EXTRACT HISTORY FROM RENDERED DOM (Primary Method)
// =========================================================
async function extractHistoryFromDOM(page) {
    const result = { priceHistoryText: "", listedForSale: "", soldOn: "" };

    try {
        // Scroll to trigger lazy rendering of the price history section
        await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('h2, h3'));
            const ph = headers.find(h => (h.innerText || '').toLowerCase().includes('price history'));
            if (ph) ph.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(2500);

        const data = await page.evaluate(() => {
            const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const headers = Array.from(document.querySelectorAll('h2, h3'));
            const phHeader = headers.find(h => cleanText(h.innerText).toLowerCase() === 'price history');
            if (!phHeader) return { lines: [], listedForSale: '', soldOn: '' };

            // Walk up to find the table container
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

        if (result.priceHistoryText) {
            console.log(`   📊 History from DOM: ${data.lines.length} rows`);
        }
    } catch (e) {
        console.log(`   ⚠️ DOM history: ${e.message}`);
    }

    return result;
}

// =========================================================
// EXTRACT PAGE DATA (includes DOM history)
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

    // Canonical
    const ogMatch = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i);
    if (ogMatch) out.canonicalUrl = ogMatch[1];

    // zpid
    const zpidMatch = originalUrl.match(/\/(\d+)_zpid/);
    if (zpidMatch) out.zpid = zpidMatch[1];

    // __NEXT_DATA__
    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (nextMatch) {
        try {
            const json = JSON.parse(nextMatch[1]);
            const rawCache = json?.props?.pageProps?.componentProps?.gdpClientCache;
            if (rawCache) {
                const parsed = JSON.parse(rawCache);
                const key = Object.keys(parsed).find(k => parsed[k]?.property);
                const p = parsed[key]?.property;
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
                    else if (out.price && out.sqft) out.pricePerSqft = Math.round(Number(out.price) / Number(out.sqft));
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
        } catch (e) {}
    }

    // --- History from DOM (in-browser, uses session cookies) ---
    const history = await extractHistoryFromDOM(page);
    out.priceHistoryText = history.priceHistoryText;
    if (history.listedForSale && !out.listedForSale) out.listedForSale = history.listedForSale;
    if (history.soldOn && !out.soldOn) out.soldOn = history.soldOn;

    // Facts & Features (best-effort)
    try {
        const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const ffSection = html.match(/Facts &amp; Features([\s\S]{0,50000})/i);
        if (ffSection) {
            const text = ffSection[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n');
            out.factsFeaturesText = text.split('\n').map(l => cleanText(l)).filter(Boolean).join("\n").slice(0, 45000);
        }
    } catch (e) {}

    // Page text
    try {
        out.pageText = await page.evaluate(() => document.body.innerText || "");
    } catch (e) {}

    return out;
}

// =========================================================
// BLOCK DETECTION
// =========================================================
function isBlocked(title, bodyText) {
    const t = (title || '').toLowerCase();
    const b = (bodyText || '').toLowerCase();
    return t.includes('pardon our interruption') || t.includes('robot check') || t.includes('access denied') || b.includes('pardon our interruption');
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log("🚀 Starting Edge Scraper V16 (DOM-based history)...");

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

    // Warm-up
    try {
        console.log("🍪 Warming up...");
        const warm = await preparePage(browser);
        await warm.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(jitter(3000, 5000));
        const warmTitle = await warm.title();
        if (isBlocked(warmTitle, "")) {
            console.log("🛑 Warm-up blocked. Aborting.");
            await warm.close();
            await browser.close();
            if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            return;
        }
        await warm.close();
        console.log("🍪 Warm-up done.");
    } catch (e) {
        console.warn(`⚠️ Warm-up: ${e.message}`);
    }

    let scrapeCount = 0;
    let rowsRemaining = false;
    let ipBlocked = false;
    let staged = [];

    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
        if (ipBlocked) break;
        if (Date.now() - startTime > MAX_RUNTIME_MS) { rowsRemaining = true; break; }
        if (scrapeCount >= MAX_ROWS_PER_RUN) { rowsRemaining = true; break; }

        const originalUrl = sheet.getCell(rowIndex, 0).value;
        const status = sheet.getCell(rowIndex, 17).value || "";

        if (!originalUrl || !String(originalUrl).includes("zillow.com") || String(status).includes("✅")) continue;

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Row ${actualRowNumber}: ${originalUrl}`);

        let page;
        try {
            page = await preparePage(browser);
            await humanNavigate(page, originalUrl);

            const title = await page.title();
            let bodySnippet = "";
            try { bodySnippet = await page.evaluate(() => (document.body?.innerText || "").slice(0, 500)); } catch (_) {}

            if (isBlocked(title, bodySnippet)) {
                console.log(`🛑 BLOCKED on Row ${actualRowNumber} — stopping.`);
                setCell(rowIndex, 17, "❌ BLOCKED");
                ipBlocked = true;
                rowsRemaining = false;
                await sheet.saveUpdatedCells();
                break;
            }

            // Check for __NEXT_DATA__ presence
            const hasNextData = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
            if (!hasNextData) {
                console.log(`   ⚠️ No __NEXT_DATA__ — page may be blocked or wrong template`);
                setCell(rowIndex, 17, "🚫 No data (blocked?)");
                ipBlocked = true;
                break;
            }

            setCell(rowIndex, 17, "Parsing + History...");
            const data = await extractPageData(page, originalUrl);
            const finalUrl = data.canonicalUrl || originalUrl;

            setCell(rowIndex, 9,  data.price);
            setCell(rowIndex, 10, data.street);
            setCell(rowIndex, 11, data.city);
            setCell(rowIndex, 12, data.state);
            setCell(rowIndex, 13, data.zipcode);
            setCell(rowIndex, 14, finalUrl);
            setCell(rowIndex, 15, data.agentDetails);
            setCell(rowIndex, 16, data.soldPrice);
            setCell(rowIndex, 17, "✅ Done (Edge)");
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

            staged.push(rowIndex);
            scrapeCount++;
            console.log(`   ✔️ ${data.fullAddress || '?'} | 💰 ${data.price || '?'} | 📊 Hist: ${data.priceHistoryText ? 'YES' : 'NO'}`);

        } catch (e) {
            console.error(`   🛑 Error: ${e.message}`);
            setCell(rowIndex, 17, "🛑 Error: " + e.message);
            staged.push(rowIndex);
        } finally {
            if (page) await page.close().catch(() => {});
        }

        if (staged.length >= FLUSH_BATCH_SIZE) {
            await sheet.saveUpdatedCells();
            staged = [];
        }
        await delay(SLEEP_BETWEEN_ROWS_MS + jitter(0, 400));
    }

    if (staged.length > 0) await sheet.saveUpdatedCells();
    await browser.close();

    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
        else fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
    }
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
