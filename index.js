const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// 1. EXPONENTIAL BACKOFF (Google API 500 Error Fix)
// =========================================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return;
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API remains unavailable.");
                throw error;
            }
            const waitTime = (2 ** i) * 1000;
            console.log(`⚠️ Google API 500/Timeout. Retrying in ${2 ** i} seconds...`);
            await delay(waitTime);
        }
    }
}

// =========================================================
// 2. HELPERS
// =========================================================
function formatPhone(raw) {
    if (!raw) return "";
    let digits = String(raw).replace(/^\+1/, '').replace(/\D/g, '');
    if (digits.length === 10) {
        return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6, 10)}`;
    }
    return String(raw);
}

function cleanText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
}

// Google Sheets hard cell limit is 50,000 chars; keep a safe margin
const MAX_CELL_LEN = 49000;
function safeCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…[truncated]" : s;
}

// =========================================================
// 3. CORE SCRAPER — FULL DETAIL EXTRACTION
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Full-Detail Stealth Scraper V11...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // A..AH = 34 columns (indices 0..33). Resize BEFORE loadCells.
    const REQUIRED_COLS = 34;
    if (sheet.columnCount < REQUIRED_COLS) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to ${REQUIRED_COLS}...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    }
    await sheet.loadCells();
    console.log(`📊 Sheet ready: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    // Defensive cell writer — never throws on out-of-bounds
    const setCell = (r, c, v) => {
        if (c >= sheet.columnCount) {
            console.warn(`⚠️ Skipping write to column ${c} (sheet only has ${sheet.columnCount} cols)`);
            return;
        }
        sheet.getCell(r, c).value = safeCell(v);
    };

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    const FLUSH_BATCH_SIZE = 10;
    let stagedCellsToSave = [];

    // Column map (0-indexed):
    // 0  A = Original URL
    // 9  J = Price
    // 10 K = Street
    // 11 L = City
    // 12 M = State
    // 13 N = Zipcode
    // 14 O = Canonical Zillow Link
    // 15 P = Agent Details
    // 16 Q = Sold Price
    // 17 R = Status
    // 18 S = Description
    // 19 T = Full Address
    // 20 U = Price Per Sqft
    // 21 V = Beds
    // 22 W = Baths
    // 23 X = Sqft
    // 24 Y = Lot Size
    // 25 Z = Listed for sale (date + price)
    // 26 AA = Sold On (date)
    // 27 AB = MLS
    // 28 AC = Property Type
    // 29 AD = Year Built
    // 30 AE = HOA
    // 31 AF = Price History (formatted)
    // 32 AG = Facts & Features (formatted)
    // 33 AH = Whole Page Text (formatted)

    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {

        const originalUrl = sheet.getCell(rowIndex, 0).value;
        const status = sheet.getCell(rowIndex, 17).value || "";

        if (!originalUrl) continue;
        if (!String(originalUrl).includes("zillow.com") || String(status).includes("✅")) continue;

        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Shutting down to rotate environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Scraping Row ${actualRowNumber}: ${originalUrl}`);

        const page = await browser.newPage();

        try {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await delay(Math.floor(Math.random() * 500) + 500);
            await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP flagged on Row ${actualRowNumber}`);
                setCell(rowIndex, 17, "❌ BLOCKED (IP Burned)");
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // Wait for Facts & Features or Price History to appear (best-effort)
            try {
                await page.waitForFunction(() => {
                    const t = document.body.innerText || "";
                    return t.includes("Price history") || t.includes("Facts & Features") || t.includes("Interior");
                }, { timeout: 10000 });
            } catch (_) { /* continue anyway */ }

            // Expand any "Show more" / "See all" buttons
            try {
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    for (const b of btns) {
                        const t = (b.innerText || "").toLowerCase();
                        if (t.includes("show more") || t.includes("see all") || t.includes("view more")) {
                            b.click();
                        }
                    }
                });
                await delay(800);
            } catch (_) {}

            // =========================================================
            // 4. EXTRACTION
            // =========================================================
            const extractedData = await page.evaluate(() => {
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

                // --- Canonical URL ---
                out.canonicalUrl =
                    document.querySelector('meta[property="og:url"]')?.content ||
                    document.querySelector('link[rel="canonical"]')?.href || "";

                // --- Parse __NEXT_DATA__ ---
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

                    if (p.resoFacts?.pricePerSquareFoot) {
                        out.pricePerSqft = p.resoFacts.pricePerSquareFoot;
                    } else if (out.price && out.sqft) {
                        out.pricePerSqft = Math.round(Number(out.price) / Number(out.sqft));
                    }

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

                // --- Price History table ---
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
                                .map(c => cleanText(c.innerText))
                                .filter(Boolean);
                            if (cells.length) lines.push(cells.join(" | "));
                        }
                        out.priceHistoryText = lines.join("\n");

                        // Parse Listed for sale & Sold On from rows
                        for (const tr of rows) {
                            const cells = Array.from(tr.querySelectorAll('td'))
                                .map(c => cleanText(c.innerText));
                            if (cells.length >= 3) {
                                const date = cells[0];
                                const event = (cells[1] || "").toLowerCase();
                                const price = cells[2];
                                if (event.includes("listed for sale") && !out.listedForSale) {
                                    out.listedForSale = `${date} (${price})`;
                                }
                                if (event.includes("sold") && !out.soldOn) {
                                    out.soldOn = date;
                                }
                            }
                        }
                    }
                } catch (e) {}

                // --- Facts & Features text ---
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
                            const h6s = parent.querySelectorAll('h6');
                            for (const h6 of h6s) {
                                const cat = cleanText(h6.innerText);
                                const ul = h6.parentElement.querySelector('ul');
                                if (!ul) continue;
                                const items = Array.from(ul.querySelectorAll('li'))
                                    .map(li => cleanText(li.innerText))
                                    .filter(Boolean);
                                if (items.length) facts.push(`${cat}: ${items.join("; ")}`);
                            }
                            if (facts.length) lines.push(`[${secName}]\n${facts.join("\n")}`);
                        }
                        out.factsFeaturesText = lines.join("\n\n");
                    }
                } catch (e) {}

                // --- Whole page text (formatted) ---
                try {
                    const raw = document.body.innerText || "";
                    out.pageText = raw
                        .split("\n")
                        .map(l => l.replace(/[ \t]+/g, " ").trim())
                        .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
                        .join("\n");
                } catch (e) {}

                return out;
            });

            // =========================================================
            // 5. WRITE TO SHEET (using safe setCell)
            // =========================================================
            const finalUrl = extractedData.canonicalUrl || originalUrl;

            setCell(rowIndex, 9,  extractedData.price);
            setCell(rowIndex, 10, extractedData.street);
            setCell(rowIndex, 11, extractedData.city);
            setCell(rowIndex, 12, extractedData.state);
            setCell(rowIndex, 13, extractedData.zipcode);
            setCell(rowIndex, 14, finalUrl);
            setCell(rowIndex, 15, extractedData.agentDetails);
            setCell(rowIndex, 16, extractedData.soldPrice);
            setCell(rowIndex, 17, "✅ SUCCESS");
            setCell(rowIndex, 18, extractedData.description);
            setCell(rowIndex, 19, extractedData.fullAddress);
            setCell(rowIndex, 20, extractedData.pricePerSqft);
            setCell(rowIndex, 21, extractedData.beds);
            setCell(rowIndex, 22, extractedData.baths);
            setCell(rowIndex, 23, extractedData.sqft);
            setCell(rowIndex, 24, extractedData.lotSize);
            setCell(rowIndex, 25, extractedData.listedForSale);
            setCell(rowIndex, 26, extractedData.soldOn);
            setCell(rowIndex, 27, extractedData.mls);
            setCell(rowIndex, 28, extractedData.propertyType);
            setCell(rowIndex, 29, extractedData.yearBuilt);
            setCell(rowIndex, 30, extractedData.hoa);
            setCell(rowIndex, 31, extractedData.priceHistoryText);
            setCell(rowIndex, 32, extractedData.factsFeaturesText);
            setCell(rowIndex, 33, extractedData.pageText);

            stagedCellsToSave.push(rowIndex);
            console.log(`✔️ Row ${actualRowNumber} | 💰 ${extractedData.price} | 🛏 ${extractedData.beds} 🛁 ${extractedData.baths} | 📅 Listed ${extractedData.listedForSale || "-"} | Sold ${extractedData.soldOn || "-"}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            setCell(rowIndex, 17, "🛑 Error: " + e.message);
            stagedCellsToSave.push(rowIndex);
        } finally {
            await page.close();
        }

        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flushing batch of ${stagedCellsToSave.length} records...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = [];
        }
    }

    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flushing final ${stagedCellsToSave.length} records...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Remaining links found. Relaying trigger token...");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Entire sheet processing completed!");
        }
    }
}

runScraper();
