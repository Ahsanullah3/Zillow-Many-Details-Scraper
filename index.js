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

    // Columns: A=URL, B-K existing, L-S new mapping, T+ = full-page extras
    // We'll ensure at least 30 columns exist.
    const REQUIRED_COLS = 30;
    if (sheet.columnCount < REQUIRED_COLS) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to ${REQUIRED_COLS}...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    }

    await sheet.loadCells();

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
    // 1  B = (existing)
    // ...
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
    // 25 Z = Listed for sale (date)
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
                sheet.getCell(rowIndex, 17).value = "❌ BLOCKED (IP Burned)";
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
                    // Price
                    out.price = p.price || "";

                    // Address parts
                    out.street = p.address?.streetAddress || p.streetAddress || "";
                    out.city   = p.address?.city        || p.city        || "";
                    out.state  = p.address?.state       || p.state       || "";
                    out.zipcode= p.address?.zipcode     || p.zipcode     || "";
                    out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(", ");

                    // Beds / Baths / Sqft
                    out.beds = p.bedrooms ?? p.resoFacts?.bedrooms ?? "";
                    out.baths = p.bathrooms ?? p.resoFacts?.bathrooms ?? "";
                    out.sqft = p.livingAreaValue ?? p.livingArea ?? p.resoFacts?.livingArea ?? "";
                    if (p.resoFacts?.pricePerSquareFoot) {
                        out.pricePerSqft = p.resoFacts.pricePerSquareFoot;
                    } else if (out.price && out.sqft) {
                        out.pricePerSqft = Math.round(Number(out.price) / Number(out.sqft));
                    }

                    // Lot size
                    const lotStr = p.resoFacts?.lotSize || "";
                    const lotAcres = p.lotAreaValue || "";
                    const lotUnits = p.lotAreaUnits || "";
                    out.lotSize = lotStr || (lotAcres ? `${lotAcres} ${lotUnits}`.trim() : "");

                    // Agent
                    if (p.attributionInfo) {
                        const name = p.attributionInfo.agentName || "";
                        const broker = p.attributionInfo.brokerName || "";
                        const phone = p.attributionInfo.agentPhoneNumber || "";
                        out.agentDetails = [name, broker, phone].filter(Boolean).join(" | ");
                    }

                    // Sold price
                    out.soldPrice = p.lastSoldPrice || "";

                    // Description
                    out.description = p.description || p.homeDescription || "N/A";

                    // MLS
                    const mlsId = p.attributionInfo?.mlsId || "";
                    const mlsName = p.attributionInfo?.mlsName || "";
                    out.mls = [mlsId, mlsName].filter(Boolean).join(" - ");

                    // Property Type
                    out.propertyType = p.homeType || p.resoFacts?.homeType || p.propertyTypeDimension || "";

                    // Year Built
                    out.yearBuilt = p.yearBuilt || p.resoFacts?.yearBuilt || "";

                    // HOA
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
                        // Walk up to the section container and find the table
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
                    const headers = Array.from(document.querySelectorAll('h3'));
                    const ffHeader = headers.find(h => cleanText(h.innerText).toLowerCase().includes("facts"));
                    // Some pages don't have an FF header; grab all h6 fact categories
                    const factHeaders = Array.from(document.querySelectorAll('h6'));
                    if (factHeaders.length) {
                        const lines = [];
                        // Group by category section (h3)
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
                    // Normalize: collapse blank lines, strip repeated whitespace
                    out.pageText = raw
                        .split("\n")
                        .map(l => l.replace(/[ \t]+/g, " ").trim())
                        .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
                        .join("\n");
                } catch (e) {}

                return out;
            });

            // =========================================================
            // 5. WRITE TO SHEET (expanded columns)
            // =========================================================
            const finalUrl = extractedData.canonicalUrl || originalUrl;

            sheet.getCell(rowIndex, 9).value  = extractedData.price;
            sheet.getCell(rowIndex, 10).value = extractedData.street;
            sheet.getCell(rowIndex, 11).value = extractedData.city;
            sheet.getCell(rowIndex, 12).value = extractedData.state;
            sheet.getCell(rowIndex, 13).value = extractedData.zipcode;
            sheet.getCell(rowIndex, 14).value = finalUrl;
            sheet.getCell(rowIndex, 15).value = extractedData.agentDetails;
            sheet.getCell(rowIndex, 16).value = extractedData.soldPrice;
            sheet.getCell(rowIndex, 17).value = "✅ SUCCESS";
            sheet.getCell(rowIndex, 18).value = extractedData.description;

            // New columns
            sheet.getCell(rowIndex, 19).value = extractedData.fullAddress;      // T
            sheet.getCell(rowIndex, 20).value = extractedData.pricePerSqft;     // U
            sheet.getCell(rowIndex, 21).value = extractedData.beds;             // V
            sheet.getCell(rowIndex, 22).value = extractedData.baths;            // W
            sheet.getCell(rowIndex, 23).value = extractedData.sqft;             // X
            sheet.getCell(rowIndex, 24).value = extractedData.lotSize;          // Y
            sheet.getCell(rowIndex, 25).value = extractedData.listedForSale;    // Z
            sheet.getCell(rowIndex, 26).value = extractedData.soldOn;           // AA
            sheet.getCell(rowIndex, 27).value = extractedData.mls;              // AB
            sheet.getCell(rowIndex, 28).value = extractedData.propertyType;     // AC
            sheet.getCell(rowIndex, 29).value = extractedData.yearBuilt;        // AD
            sheet.getCell(rowIndex, 30).value = extractedData.hoa;              // AE
            sheet.getCell(rowIndex, 31).value = extractedData.priceHistoryText; // AF
            sheet.getCell(rowIndex, 32).value = extractedData.factsFeaturesText;// AG
            sheet.getCell(rowIndex, 33).value = extractedData.pageText;         // AH

            stagedCellsToSave.push(rowIndex);
            console.log(`✔️ Row ${actualRowNumber} | 💰 ${extractedData.price} | 🛏 ${extractedData.beds} 🛁 ${extractedData.baths} | 📅 Listed ${extractedData.listedForSale} | Sold ${extractedData.soldOn}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 17).value = "🛑 Error: " + e.message;
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
