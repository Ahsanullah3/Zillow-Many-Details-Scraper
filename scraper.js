const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG
// =========================================================
const MAX_RUNTIME_MS = 780000;        // 13 min per batch
const MIN_SLEEP_MS = 4000;            // pause between rows
const MAX_SLEEP_MS = 9000;
const MAX_ROWS_PER_RUN = 30;           // successful rows per batch (blocked rows don't count)
const REQUIRED_COLS = 34;
const FLUSH_BATCH_SIZE = 5;
const MAX_CONSECUTIVE_ERRORS = 3;     // stop run if things keep failing
const MAX_BLOCK_STREAK = 3;           // this many blocks in a row = IP flagged -> end batch, next batch gets a new IP
const BATCH_NUMBER = parseInt(process.env.BATCH_NUMBER || '1', 10) || 1;
// Batch 1 (cron start / manual start) retries previously blocked rows; later chained batches skip them.
const RETRY_BLOCKED = BATCH_NUMBER === 1 || process.env.RETRY_BLOCKED === '1';
const isBlockedStatus = (st) => /BLOCKED|No data/i.test(String(st || ''));
// Request interception disables the browser cache and slightly changes traffic shape,
// so it's OFF by default. Set e.g. ['media'] only if you need to save bandwidth.
const BLOCKED_RESOURCES = [];
const VIEWPORTS = [[1366, 768], [1440, 900], [1536, 864], [1920, 1080]];
const [VP_W, VP_H] = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]; // one size per run
const TIMEZONE = process.env.TIMEZONE || 'America/New_York'; // match a US IP
const PAUSE_EVERY = [6, 11];         // take a longer "human" break every N rows
const PAUSE_MS = [20000, 45000];

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
    console.log(`🖥️ ${HEADFUL ? 'Headful' : 'Headless'} | window ${VP_W}x${VP_H} | tz ${TIMEZONE}`);

    return puppeteer.launch({
        headless: HEADFUL ? false : 'new',
        ...(execPath ? { executablePath: execPath } : {}),
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--password-store=basic',
            '--lang=en-US,en',
            `--window-size=${VP_W},${VP_H}`,
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

    // NOTE: no manual setUserAgent. The stealth plugin's user-agent-override already
    // strips "Headless" AND sets matching client-hint metadata (sec-ch-ua, platform).
    // Setting the UA by hand wipes that metadata and creates a mismatch.

    if (!HEADFUL) await page.setViewport({ width: VP_W, height: VP_H, deviceScaleFactor: 1 });
    await page.emulateTimezone(TIMEZONE).catch(() => {});
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    if (BLOCKED_RESOURCES.length) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (BLOCKED_RESOURCES.includes(req.resourceType())) req.abort().catch(() => {});
            else req.continue().catch(() => {});
        });
    }
    return page;
}

// =========================================================
// HUMAN-LIKE BEHAVIOUR
// =========================================================
// Smooth curved mouse path (quadratic bezier) instead of a straight jump
async function humanMouse(page, toX, toY) {
    try {
        const fromX = jitter(50, VP_W - 50), fromY = jitter(50, VP_H - 50);
        const cx = (fromX + toX) / 2 + jitter(-150, 150);
        const cy = (fromY + toY) / 2 + jitter(-150, 150);
        const steps = jitter(18, 40);
        await page.mouse.move(fromX, fromY);
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const x = (1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * cx + t * t * toX;
            const y = (1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * cy + t * t * toY;
            await page.mouse.move(x, y);
            if (i % 6 === 0) await delay(jitter(5, 25));
        }
    } catch (_) {}
}

// Scroll down in uneven chunks, sometimes back up a little, with reading pauses
async function humanScroll(page) {
    try {
        const chunks = jitter(3, 7);
        for (let i = 0; i < chunks; i++) {
            const dy = jitter(150, 480);
            await page.mouse.wheel({ deltaY: dy });
            await delay(jitter(350, 1100));
            if (Math.random() < 0.2) {
                await page.mouse.wheel({ deltaY: -jitter(60, 200) });
                await delay(jitter(300, 800));
            }
        }
    } catch (_) {}
}

async function humanNavigate(page, url) {
    await delay(jitter(1200, 3500));
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
        referer: Math.random() < 0.7 ? 'https://www.google.com/' : 'https://www.zillow.com/',
    });
    await delay(jitter(900, 2200));                       // page "loads"
    await humanMouse(page, jitter(200, VP_W - 200), jitter(150, VP_H - 150));
    await humanScroll(page);
    await delay(jitter(1000, 3000));                      // reading time
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

    const setOutput = (hasMore, blocked = false) => {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`);
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
    let ipFlagged = false;   // IP looks burned: ended batch after a streak of blocks
    let blockStreak = 0;
    let streakRows = [];
    let skippedBlocked = 0;
    let consecutiveErrors = 0;
    let stoppedEarly = false;
    let dirty = 0;

    const flush = async () => {
        if (dirty > 0) {
            await sheet.saveUpdatedCells();
            dirty = 0;
        }
    };

    let rowsSincePause = 0;
    let nextPauseAt = jitter(PAUSE_EVERY[0], PAUSE_EVERY[1]);
    const pace = async () => {
        if (dirty >= FLUSH_BATCH_SIZE) await flush();
        await delay(jitter(MIN_SLEEP_MS, MAX_SLEEP_MS));
        rowsSincePause++;
        if (rowsSincePause >= nextPauseAt) {
            const ms = jitter(PAUSE_MS[0], PAUSE_MS[1]);
            console.log(`   ☕ Taking a ${Math.round(ms / 1000)}s break`);
            await delay(ms);
            rowsSincePause = 0;
            nextPauseAt = jitter(PAUSE_EVERY[0], PAUSE_EVERY[1]);
        }
    };

    // Marks the row blocked and SKIPS it. Returns true if the IP looks flagged
    // (several blocks in a row), in which case those rows are reset so the next
    // batch retries them on a fresh IP.
    const handleBlock = (rowIndex, label) => {
        setCell(rowIndex, 17, label);
        dirty++;
        blockStreak++;
        streakRows.push(rowIndex);
        if (blockStreak >= MAX_BLOCK_STREAK) {
            console.log(`🛑 ${blockStreak} blocks in a row — IP flagged. Resetting those rows and ending batch.`);
            for (const r of streakRows) { setCell(r, 17, ""); dirty++; }
            ipFlagged = true;
            rowsRemaining = true;
            return true;
        }
        console.log(`   ⏭️ Row blocked — skipping (${blockStreak}/${MAX_BLOCK_STREAK} in a row)`);
        return false;
    };

    try {
        page = await preparePage(browser);

        // Warm-up on the SAME page/session
        try {
            console.log("🍪 Warming up...");
            await page.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await delay(jitter(3000, 5000));
            if (await checkBlocked(page)) {
                console.log("🛑 Warm-up blocked (IP likely flagged). Ending batch; next batch gets a new IP.");
                setOutput(true, true);
                return;
            }
            console.log("🍪 Warm-up done.");
        } catch (e) {
            console.warn(`⚠️ Warm-up: ${e.message}`);
        }

        for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
            if (ipFlagged) break;
            if (Date.now() - startTime > MAX_RUNTIME_MS) { rowsRemaining = true; break; }
            if (scrapeCount >= MAX_ROWS_PER_RUN) { rowsRemaining = true; break; }
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.log(`🛑 ${MAX_CONSECUTIVE_ERRORS} errors in a row — stopping run.`);
                stoppedEarly = true;
                break;
            }

            const originalUrl = sheet.getCell(rowIndex, 0).value;
            const status = sheet.getCell(rowIndex, 17).value || "";

            if (!originalUrl || !String(originalUrl).includes("zillow.com") || String(status).includes("✅")) continue;
            if (isBlockedStatus(status) && !RETRY_BLOCKED) { skippedBlocked++; continue; }

            const actualRowNumber = rowIndex + 1;
            console.log(`🕵️ Row ${actualRowNumber}: ${originalUrl}`);

            try {
                await humanNavigate(page, String(originalUrl));

                if (await checkBlocked(page)) {
                    console.log(`🛑 BLOCKED on Row ${actualRowNumber}`);
                    if (handleBlock(rowIndex, "❌ BLOCKED")) break;
                    await pace();
                    continue;
                }

                const hasNextData = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
                if (!hasNextData) {
                    console.log(`   ⚠️ No __NEXT_DATA__ — treating as blocked`);
                    if (handleBlock(rowIndex, "🚫 No data (blocked?)")) break;
                    await pace();
                    continue;
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
                    await pace();
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
                blockStreak = 0;     // earlier blocked rows were row-specific: they stay skipped
                streakRows = [];
                console.log(`   ✔️ ${data.fullAddress || '?'} | 💰 ${data.price || '?'} | 📊 Hist: ${data.priceHistoryText ? 'YES' : 'NO'}`);

            } catch (e) {
                console.error(`   🛑 Error: ${e.message}`);
                setCell(rowIndex, 17, "🛑 Error: " + e.message);
                dirty++;
                consecutiveErrors++;

                // If the page itself died, open a fresh one
                if (page.isClosed()) page = await preparePage(browser);
            }

            await pace();
        }
    } finally {
        // Always save pending changes (including BLOCKED status) before exiting
        try { await flush(); } catch (e) { console.error(`⚠️ Final save failed: ${e.message}`); }
        await browser.close().catch(() => {});
    }

    if (skippedBlocked) console.log(`⏭️ Skipped ${skippedBlocked} previously blocked rows`);
    // blocked=true only when the batch made zero progress because of blocks
    setOutput(rowsRemaining || stoppedEarly, ipFlagged && scrapeCount === 0);
}

runScraper().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
