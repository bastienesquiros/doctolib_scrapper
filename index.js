import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";
import "dotenv/config";

puppeteer.use(StealthPlugin());

// --- Config ---

const STATE_FILE = path.join(process.cwd(), "doctolib_state.json");
const {TELEGRAM_TOKEN, CHAT_ID} = process.env;
const MAX_RETRIES = 3;
const FETCH_CONCURRENCY = 3;

const SEARCH_URLS = [
    "https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14",
    "https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14",
];

// --- Utils ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reloaded each cycle so you can update .env without restarting
const getBlacklist = () => new Set(
    (process.env.BLACKLISTED_AGENDA_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);

const loadState = () => {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        for (const v of Object.values(raw)) delete v.next_slot; // legacy key
        return raw;
    } catch {
        return {};
    }
};
const saveState = (data) => fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));

const formatDate = (iso) => new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris", weekday: "long", day: "numeric",
    month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
});

const parseLabel = (url) => {
    const u = new URL(url);
    const city = u.searchParams.get("location")?.toUpperCase() ?? "UNKNOWN";
    const keyword = u.searchParams.get("keyword")?.toUpperCase() ?? "UNKNOWN";
    return `${city} | ${keyword}`;
};

// Run async tasks with a max concurrency (index-based to avoid race conditions)
async function poolAll(items, fn, concurrency) {
    let idx = 0;
    await Promise.all(
        Array.from({length: Math.min(concurrency, items.length)}, async () => {
            while (true) {
                const i = idx++;
                if (i >= items.length) break;
                await fn(items[i]);
            }
        })
    );
}

async function sendTelegram(text) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({chat_id: CHAT_ID, text}),
        });
        const data = await res.json();
        if (!data.ok) console.error("❌ Telegram error:", data);
    } catch (err) {
        console.error("❌ Telegram request failed:", err.message);
    }
}

// --- Puppeteer ---

async function scrapeEndpoints(browser, searchUrl) {
    const endpoints = new Set();
    const page = await browser.newPage();
    try {
        page.on("request", (req) => {
            if (req.url().includes("/search/availabilities.json")) endpoints.add(req.url());
        });
        await page.goto(searchUrl, {waitUntil: "networkidle2", timeout: 60000});
        await sleep(3000); // wait for JS-rendered cards to start loading after initial page load

        // Jump to bottom each iteration — triggers IntersectionObserver for all cards at once
        // Stop when page height stops growing (all doctors loaded)
        let stalledSteps = 0;
        let prevHeight = await page.evaluate(() => document.body.scrollHeight);
        while (stalledSteps < 3) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await sleep(2500); // wait long enough for each batch of cards to load
            const height = await page.evaluate(() => document.body.scrollHeight);
            if (height === prevHeight) {
                stalledSteps++;
            } else {
                stalledSteps = 0;
                prevHeight = height;
            }
        }
    } finally {
        await page.close();
    }
    return endpoints;
}

async function getAllEndpoints() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: {width: 1920, height: 1080},
    });
    const endpointMap = new Map(); // jsonUrl -> searchUrl

    try {
        for (const searchUrl of SEARCH_URLS) {
            const label = parseLabel(searchUrl);
            let endpoints = new Set();

            for (let i = 1; i <= MAX_RETRIES; i++) {
                try {
                    endpoints = await scrapeEndpoints(browser, searchUrl);
                    if (endpoints.size > 0) break;
                    console.warn(`⚠️ [${label}] No endpoints (attempt ${i}/${MAX_RETRIES})`);
                } catch (err) {
                    console.error(`❌ [${label}] Page error (attempt ${i}/${MAX_RETRIES}): ${err.message}`);
                }
                if (i < MAX_RETRIES) await sleep(5000);
            }

            if (endpoints.size === 0) {
                const msg = `⚠️ [${label}] Aucun endpoint après ${MAX_RETRIES} tentatives, cycle ignoré.`;
                console.error(msg);
                await sendTelegram(msg);
            } else {
                for (const url of endpoints) endpointMap.set(url, searchUrl);
            }
        }
    } finally {
        await browser.close();
    }

    return endpointMap;
}

// --- Fetch slots ---

async function fetchSlots(jsonUrl) {
    try {
        // Force limit=7 (max) to get as many slots as possible per endpoint
        const url = new URL(jsonUrl);
        url.searchParams.set("limit", "7");
        jsonUrl = url.toString();

        const raw = url.searchParams.get("agenda_ids") ?? "";
        // Normalize: sort IDs so "1-2-3" and "3-1-2" produce the same dedup key
        const agendaId = raw.split("-").sort().join("-");
        const res = await fetch(jsonUrl, {headers: {"User-Agent": "Mozilla/5.0"}});

        if (res.status === 429 || res.status === 403) {
            console.warn("⚠️ Rate limited on agenda", agendaId);
            return {slots: [], rateLimited: true};
        }

        const data = await res.json();
        const slots = (data.availabilities ?? []).flatMap((entry) =>
            (entry.slots ?? []).map((slot) => ({
                id: `${agendaId}_${slot.slice(0, 16)}`,
                agendaId,
                date: slot,
            }))
        );

        if (data.next_slot) slots.push({
            id: `ns_${agendaId}_${data.next_slot.slice(0, 16)}`,
            agendaId,
            date: data.next_slot,
        });

        return {slots, rateLimited: false};
    } catch (err) {
        console.error("💥 Fetch error:", err.message);
        return {slots: [], rateLimited: false};
    }
}

// --- Main check ---

async function check() {
    const state = loadState();
    const blacklist = getBlacklist();
    const endpointMap = await getAllEndpoints();

    // Fetch all slots with bounded concurrency, group by label
    const groups = new Map();
    let rateLimited = false;
    await poolAll([...endpointMap.entries()], async ([jsonUrl, searchUrl]) => {
        const {slots, rateLimited: rl} = await fetchSlots(jsonUrl);
        if (rl) { rateLimited = true; return; }
        if (!slots.length) return;

        const label = parseLabel(searchUrl);
        if (!groups.has(label)) groups.set(label, {slots: [], searchUrl, seen: new Set()});
        const group = groups.get(label);

        for (const slot of slots) {
            // Dedup: a grouped agenda "1-2-3" and solo agenda "2" at same time = same appointment
            // Key on every individual ID in the group + the normalized date
            const individualIds = slot.agendaId.split("-");
            const dateKey = slot.date.slice(0, 16);
            const isDupe = individualIds.some((id) => group.seen.has(`${id}_${dateKey}`));
            if (!isDupe) {
                individualIds.forEach((id) => group.seen.add(`${id}_${dateKey}`));
                group.slots.push(slot);
            }
        }
    }, FETCH_CONCURRENCY);

    if (rateLimited) {
        console.warn("⚠️ Rate limited — waiting 60s before next cycle...");
        await sleep(60000);
    }

    // Notify
    for (const [label, {slots, searchUrl}] of groups) {
        state[label] ??= {notifiedSlots: []};
        const notified = new Set(state[label].notifiedSlots);
        const newSlots = slots.filter((s) => !notified.has(s.id));

        const blacklisted = newSlots.filter((s) => blacklist.has(s.agendaId));
        const toNotify = newSlots.filter((s) => !blacklist.has(s.agendaId));

        if (blacklisted.length) {
            const ids = [...new Set(blacklisted.map((s) => s.agendaId))].join(", ");
            console.log(`🚫 [${label}] ${blacklisted.length} slot(s) blacklisté(s) ignorés (agendas: ${ids})`);
        }

        if (!toNotify.length) {
            console.log(`ℹ️ No new slots for ${label}`);
        } else {
            const header = `🩺 ${label}\n🔗 ${searchUrl}\n\n🚨 New slots:\n`;
            const lines = toNotify.map((s) => `- ${formatDate(s.date)} (agenda ${s.agendaId})`);

            // Split into chunks that fit Telegram's 4096 char limit
            const chunks = [];
            let current = header;
            for (const line of lines) {
                if ((current + line + "\n").length > 4096) {
                    chunks.push(current);
                    current = `🩺 ${label} (suite)\n\n`;
                }
                current += line + "\n";
            }
            chunks.push(current);

            for (const chunk of chunks) {
                console.log(chunk);
                await sendTelegram(chunk);
            }
        }

        newSlots.forEach((s) => notified.add(s.id));
        state[label].notifiedSlots = [...notified];
    }

    // Prune expired slots from the entire state (not just labels seen this cycle)
    const now = new Date();
    for (const entry of Object.values(state)) {
        entry.notifiedSlots = entry.notifiedSlots.filter((id) => {
            const stripped = id.replace(/^ns_/, "");
            const datePart = stripped.slice(stripped.indexOf("_") + 1);
            return new Date(datePart) >= now;
        });
    }

    saveState(state);
}

// --- Loop ---

async function main() {
    while (true) {
        try {
            await check();
        } catch (err) {
            console.error("💥 Erreur inattendue:", err);
            await sendTelegram(`💥 Erreur bot Doctolib:\n${err.message}\nReprise dans 60s...`);
            await sleep(60000);
            continue;
        }
        const delay = (8 + Math.random() * 4) * 60 * 1000;
        console.log(`⏱ Next check in ${Math.round(delay / 60000)} minutes\n`);
        await sleep(delay);
    }
}

process.on("unhandledRejection", (reason) => console.error("💥 Unhandled rejection:", reason));

main();
