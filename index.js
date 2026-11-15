const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUA = require('puppeteer-extra-plugin-anonymize-ua');
const fs = require('fs');

// =========================================================
// STEALTH PLUGINS
// =========================================================
puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUA({
    stripHeadless: true,
    makeWindows: true,
}));

// =========================================================
// CONFIG
// =========================================================
const MAX_ROWS_PER_RUN = 5;         // no proxy → keep low to protect the IP
const FLUSH_BATCH_SIZE = 3;         // smaller batches → more frequent saves
const REQUIRED_COLS = 34;           // A..AH

// =========================================================
// HELPERS
// =========================================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

const MAX_CELL_LEN = 49000;
function safeCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];
const pickUA = () => USER_AGENTS[jitter(0, USER_AGENTS.length)];

async function saveWithRetry(sheet, retries = 4) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return;
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API unavailable.");
                throw error;
            }
            const waitTime = (2 ** i) * 1000 + jitter(0, 500);
            console.log(`⚠️ Google API error. Retry in ${Math.round(waitTime / 1000)}s...`);
            await delay(waitTime);
        }
    }
}

// =========================================================
// BROWSER LAUNCH — HEADLESS + REAL CHROME
// =========================================================
async function launchBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-dev-shm-usage',
        '--lang=en-US,en',
        '--window-size=1366,768',
        // NO --disable-gpu, NO --single-process
    ];

    const launchOpts = {
        headless: "new",
        args,
        ignoreDefaultArgs: ['--enable-automation'],
    };

    // Use real Chrome if provided by CI / local env
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        console.log(`🌐 Using real Chrome: ${launchOpts.executablePath}`);
    } else {
        console.log("🌐 Using Puppeteer-bundled Chromium (set PUPPETEER_EXECUTABLE_PATH for real Chrome)");
    }

    return puppeteer.launch(launchOpts);
}

// =========================================================
// PAGE STEALTH
// =========================================================
async function preparePage(browser) {
    const page = await browser.newPage();

    await page.setUserAgent(pickUA());
    await page.setViewport({
        width: jitter(1366, 1600),
        height: jitter(768, 1000),
        deviceScaleFactor: 1,
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(t)) req.abort();
        else req.continue();
    });

    // JS-level fingerprint patches
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin' },
                { name: 'Chrome PDF Viewer' },
                { name: 'Native Client' },
            ],
        });
        window.chrome = window.chrome || { runtime: {} };
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) =>
            params.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : origQuery(params);
    });

    // CDP-level webdriver patch (belt & suspenders)
    const client = await page.target().createCDPSession();
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`,
    });

    return page;
}

// =========================================================
// HUMAN NAVIGATION
// =========================================================
async function humanNavigate(page, url) {
    await delay(jitter(1500, 3500));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    try {
        await page.mouse.move(jitter(150, 900), jitter(100, 700), { steps: jitter(5, 15) });
    } catch (_) {}
    try {
        await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 500));
    } catch (_) {}

    await delay(jitter(1200, 2500));
}

// =========================================================
// EXTRACTION (runs inside page context)
// =========================================================
function extractPageData() {
    const out = {
        price: "", street: "", city: "", state: "", zipcode: "",
        fullAddress: "", agentDetails: "", soldPrice: "",
        canonicalUrl: "", description: "", pricePerSqft: "",
        beds: "", baths: "", sqft: "", lotSize: "",
        listedForSale: "", soldOn: "", mls: "", propertyType: "",
        yearBuilt: "", hoa: "",
        priceHistoryText: "", factsFeaturesText: "", pageText: ""
    };

    const cleanText = (s) => (s || "").replace(/\s+/g, " ").trim();

    out.canonicalUrl =
        document.querySelector('meta[property="og:url"]')?.content ||
        document.querySelector('link[rel="canonical"]')?.href || "";

    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
    let p = null;
    if (nextDataScript) {
        try {
            const jsonData = JSON.parse(nextDataScript.innerText);
            const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
            if (rawCache) {
                const parsedCache = JSON.parse(rawCache);
                const key = Object.keys(parsedCache).find(k => parsedCache[k]?.property);
                p = parsedCache[key]?.property;
            }
        } catch (e) {}
    }

    if (p) {
        out.price = p.price || "";
        out.street  = p.address?.streetAddress || p.streetAddress || "";
        out.city    = p.address?.city          || p.city          || "";
        out.state   = p.address?.state         || p.state         || "";
        out.zipcode = p.address?.zipcode       || p.zipcode       || "";
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
            const name = p.attributionInfo.agentName || "";
            const broker = p.attributionInfo.brokerName || "";
            const phone = p.attributionInfo.agentPhoneNumber || "";
            out.agentDetails = [name, broker, phone].filter(Boolean).join(" | ");
        }

        out.soldPrice = p.lastSoldPrice || "";
        out.description = p.description || p.homeDescription || "N/A";

        const mlsId = p.attributionInfo?.mlsId || "";
        const mlsName = p.attributionInfo?.mlsName || "";
        out.mls = [mlsId, mlsName].filter(Boolean).join(" - ");

        out.propertyType = p.homeType || p.resoFacts?.homeType || p.propertyTypeDimension || "";
        out.yearBuilt = p.yearBuilt || p.resoFacts?.yearBuilt || "";

        if (p.monthlyHoaFee) out.hoa = `$${p.monthlyHoaFee}/mo`;
        else if (p.resoFacts?.hoaFeeTotal) out.hoa = p.resoFacts.hoaFeeTotal;
        else out.hoa = "No / None listed";
    }

    // Price history
    try {
        const headers = Array.from(document.querySelectorAll('h2,h3'));
        const phHeader = headers.find(h => cleanText(h.innerText).toLowerCase() === "price history");
        let tableEl = null;
        if (phHeader) {
            let node = phHeader;
            for (let i = 0; i < 6 && node; i++) {
                node = node.parentElement;
                if (!node) break;
                const t = node.querySelector('table');
                if (t) { tableEl = t; break; }
            }
        }
        if (tableEl) {
            const rows = Array.from(tableEl.querySelectorAll('tr'));
            const lines = [];
            for (const tr of rows) {
                const cells = Array.from(tr.querySelectorAll('th,td'))
                    .map(c => cleanText(c.innerText)).filter(Boolean);
                if (cells.length) lines.push(cells.join(" | "));
            }
            out.priceHistoryText = lines.join("\n");

            for (const tr of rows) {
                const cells = Array.from(tr.querySelectorAll('td')).map(c => cleanText(c.innerText));
                if (cells.length >= 3) {
                    const date = cells[0];
                    const event = (cells[1] || "").toLowerCase();
                    const price = cells[2];
                    if (event.includes("listed for sale") && !out.listedForSale) out.listedForSale = `${date} (${price})`;
                    if (event.includes("sold") && !out.soldOn) out.soldOn = date;
                }
            }
        }
    } catch (e) {}

    // Facts & Features
    try {
        const factHeaders = Array.from(document.querySelectorAll('h6'));
        if (factHeaders.length) {
            const lines = [];
            const sections = Array.from(document.querySelectorAll('h3'));
            for (const sec of sections) {
                const secName = cleanText(sec.innerText);
                if (!secName) continue;
                const parent = sec.closest('[data-testid="category-group"]');
                if (!parent) continue;
                const facts = [];
                for (const h6 of parent.querySelectorAll('h6')) {
                    const cat = cleanText(h6.innerText);
                    const ul = h6.parentElement.querySelector('ul');
                    if (!ul) continue;
                    const items = Array.from(ul.querySelectorAll('li'))
                        .map(li => cleanText(li.innerText)).filter(Boolean);
                    if (items.length) facts.push(`${cat}: ${items.join("; ")}`);
                }
                if (facts.length) lines.push(`[${secName}]\n${facts.join("\n")}`);
            }
            out.factsFeaturesText = lines.join("\n\n");
        }
    } catch (e) {}

    // Whole page text
    try {
        const raw = document.body.innerText || "";
        out.pageText = raw
            .split("\n")
            .map(l => l.replace(/[ \t]+/g, " ").trim())
            .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
            .join("\n");
    } catch (e) {}

    return out;
}

// =========================================================
// BLOCK DETECTION
// =========================================================
function isBlocked(title, bodyText) {
    const t = (title || "").toLowerCase();
    const b = (bodyText || "").toLowerCase();
    return (
        t.includes("pardon our interruption") ||
        t.includes("robot check") ||
        t.includes("access denied") ||
        t.includes("access to this page has been denied") ||
        b.includes("pardon our interruption") ||
        b.includes("press & hold to confirm") ||
        b.includes("verify you are a human")
    );
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Full-Detail Stealth Scraper V12 (headless + real Chrome, no proxy)...");

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
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to ${REQUIRED_COLS}...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    }
    await sheet.loadCells();
    console.log(`📊 Sheet ready: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    const setCell = (r, c, v) => {
        if (c >= sheet.columnCount) return;
        sheet.getCell(r, c).value = safeCell(v);
    };

    const browser = await launchBrowser();

    // Warm-up: clear cookies → Google referer → Zillow homepage
    try {
        console.log("🍪 Warming up...");
        const warm = await preparePage(browser);
        const client = await warm.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');

        await warm.goto('https://www.google.com/search?q=zillow+havelock+nc', {
            waitUntil: 'domcontentloaded', timeout: 60000,
        });
        await delay(jitter(2500, 4000));

        await warm.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(jitter(3000, 5000));

        const warmTitle = await warm.title();
        if (isBlocked(warmTitle, "")) {
            console.log("🛑 Warm-up page is blocked. Aborting run to protect IP.");
            await warm.close();
            await browser.close();
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            }
            return;
        }
        await warm.close();
        console.log("🍪 Warm-up done.");
    } catch (e) {
        console.warn(`⚠️ Warm-up failed: ${e.message}`);
    }

    let scrapeCount = 0;
    let rowsRemaining = false;
    let ipBlocked = false;
    let staged = [];

    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
        if (ipBlocked) break;

        const originalUrl = sheet.getCell(rowIndex, 0).value;
        const status = sheet.getCell(rowIndex, 17).value || "";

        if (!originalUrl) continue;
        if (!String(originalUrl).includes("zillow.com") || String(status).includes("✅")) continue;

        if (scrapeCount >= MAX_ROWS_PER_RUN) {
            console.log(`🛑 Reached ${MAX_ROWS_PER_RUN} rows. Stopping to protect IP...`);
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Scraping Row ${actualRowNumber}: ${originalUrl}`);

        let page;
        try {
            page = await preparePage(browser);
            await humanNavigate(page, originalUrl);

            const title = await page.title();
            let bodySnippet = "";
            try { bodySnippet = await page.evaluate(() => (document.body?.innerText || "").slice(0, 500)); } catch (_) {}

            if (isBlocked(title, bodySnippet)) {
                console.log(`🛑 BLOCKED on Row ${actualRowNumber} — stopping entire run.`);
                setCell(rowIndex, 17, "❌ BLOCKED (no proxy — IP flagged)");
                ipBlocked = true;
                rowsRemaining = false;
                await saveWithRetry(sheet);
                await page.close();
                break;
            }

            try {
                await page.waitForFunction(() => {
                    const t = document.body.innerText || "";
                    return t.includes("Price history") || t.includes("Facts & Features") || t.includes("Interior");
                }, { timeout: 12000 });
            } catch (_) {}

            try {
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    for (const b of btns) {
                        const t = (b.innerText || "").toLowerCase();
                        if (t.includes("show more") || t.includes("see all") || t.includes("view more")) b.click();
                    }
                });
                await delay(jitter(600, 1400));
            } catch (_) {}

            const data = await page.evaluate(extractPageData);
            const finalUrl = data.canonicalUrl || originalUrl;

            setCell(rowIndex, 9,  data.price);
            setCell(rowIndex, 10, data.street);
            setCell(rowIndex, 11, data.city);
            setCell(rowIndex, 12, data.state);
            setCell(rowIndex, 13, data.zipcode);
            setCell(rowIndex, 14, finalUrl);
            setCell(rowIndex, 15, data.agentDetails);
            setCell(rowIndex, 16, data.soldPrice);
            setCell(rowIndex, 17, "✅ SUCCESS");
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
            console.log(`✔️ Row ${actualRowNumber} | 💰 ${data.price} | 🛏 ${data.beds} 🛁 ${data.baths} | 📅 ${data.listedForSale || "-"} → ${data.soldOn || "-"}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error Row ${actualRowNumber}: ${e.message}`);
            setCell(rowIndex, 17, "🛑 Error: " + e.message);
            staged.push(rowIndex);
        } finally {
            if (page) await page.close().catch(() => {});
        }

        if (staged.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flushing batch of ${staged.length}...`);
            await saveWithRetry(sheet);
            staged = [];
        }
    }

    if (staged.length > 0) {
        console.log(`📦 Flushing final ${staged.length}...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Remaining links found. Relaying trigger token...");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Run completed (or stopped by block).");
        }
    }
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
