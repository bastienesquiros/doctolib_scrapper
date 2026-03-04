import puppeteer from "puppeteer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { URL } from "url";
import 'dotenv/config';

// --------------------
// Config
// --------------------
const STATE_FILE = path.join(process.cwd(), "lastSlots.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SEARCH_URLS = [
    "https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14",
    "https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14"
];

// --------------------
// Utils
// --------------------
const loadLastSlots = () => {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {};
    }
};

const saveLastSlots = (data) => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
};

const formatFrenchDate = (isoString) => {
    const date = new Date(isoString);
    const options = {
        timeZone: "Europe/Paris",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    };
    return date.toLocaleDateString("fr-FR", options);
};

const parseUrl = (url) => {
    const u = new URL(url);
    const city = u.searchParams.get("location")?.toUpperCase() || "UNKNOWN";
    const keyword = u.searchParams.get("keyword")?.toUpperCase() || "UNKNOWN";
    return { city, keyword };
};

const sendTelegram = async (message) => {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return console.warn("⚠️ Telegram token/Chat ID not set in .env");
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
        });
        const data = await res.json();
        if (!data.ok) console.error("❌ Telegram error:", data);
    } catch (err) {
        console.error("❌ Telegram fetch error:", err);
    }
};

// Normalize slots to avoid duplicates (ignore seconds)
const normalizeSlot = (slot) => slot.slice(0, 16);

// --------------------
// Puppeteer helpers
// --------------------
const autoScroll = async (page) => {
    let totalHeight = 0;
    const distance = 300;
    while (true) {
        const scrollHeight = await page.evaluate("document.body.scrollHeight");
        await page.evaluate(`window.scrollBy(0, ${distance})`);
        totalHeight += distance;
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 300));
        if (totalHeight >= scrollHeight) break;
    }
    await new Promise((r) => setTimeout(r, 3000));
};

const getAvailabilityEndpoints = async () => {
    const endpointMap = new Map();
    for (const searchUrl of SEARCH_URLS) {
        const browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        page.on("request", (request) => {
            const reqUrl = request.url();
            if (reqUrl.includes("/search/availabilities.json")) {
                endpointMap.set(reqUrl, searchUrl);
            }
        });
        await page.goto(searchUrl, { waitUntil: "networkidle2" });
        await autoScroll(page);
        await browser.close();
    }
    return endpointMap;
};

// --------------------
// Fetch JSON & extract slots
// --------------------
const fetchSlots = async (jsonUrl) => {
    try {
        const res = await fetch(jsonUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const data = await res.json();

        if (res.status === 429 || res.status === 403 || (data.error && data.error.toLowerCase().includes("try again later"))) {
            console.warn(`⚠️ Rate limited on ${jsonUrl}. Waiting 1 min before retry...`);
            await new Promise((r) => setTimeout(r, 60_000));
            return { slots: [], nextSlot: null };
        }

        const slots = data.availabilities?.flatMap(d => d.slots || []) || [];
        const nextSlot = data.next_slot || null;
        return { slots, nextSlot };
    } catch (err) {
        console.error(`💥 Error fetching ${jsonUrl}:`, err);
        return { slots: [], nextSlot: null };
    }
};

// --------------------
// Main loop
// --------------------
const checkAllEndpoints = async () => {
    const lastSlots = loadLastSlots();
    const endpointMap = await getAvailabilityEndpoints();

    const groupMap = new Map(); // key = city + keyword

    for (const [jsonUrl, searchUrl] of endpointMap.entries()) {
        const { slots, nextSlot } = await fetchSlots(jsonUrl);
        if (!slots.length && !nextSlot) continue;

        const { city, keyword } = parseUrl(searchUrl);
        const key = `${city} | ${keyword}`;

        if (!groupMap.has(key)) groupMap.set(key, { slots: [], nextSlot: null, searchUrl });
        const entry = groupMap.get(key);

        entry.slots.push(...slots);
        if (!entry.nextSlot || (nextSlot && new Date(nextSlot) < new Date(entry.nextSlot))) {
            entry.nextSlot = nextSlot;
        }
    }

    // Send notifications per group
    for (const [key, { slots, nextSlot, searchUrl }] of groupMap.entries()) {
        // Initialize safely
        if (!lastSlots[key]) lastSlots[key] = { notifiedSlots: [], next_slot: null };
        if (!Array.isArray(lastSlots[key].notifiedSlots)) lastSlots[key].notifiedSlots = [];

        // Determine new slots
        const alreadyNotified = new Set(lastSlots[key].notifiedSlots);
        const newSlotsNormalized = slots.filter(s => !alreadyNotified.has(normalizeSlot(s)));

        // Only send if there’s new info
        if (!newSlotsNormalized.length && lastSlots[key].next_slot === nextSlot) {
            console.log(`ℹ️ No new slots for ${key}`);
            continue;
        }

        let msgLines = [`🩺 ${key}`, `🔗 Doctolib: ${searchUrl}`];

        if (newSlotsNormalized.length) {
            msgLines.push(
                "🚨 New slots available:\n" +
                newSlotsNormalized.map(s => `- ${formatFrenchDate(s)}`).join("\n")
            );
        }

        if (nextSlot && nextSlot !== lastSlots[key].next_slot) {
            msgLines.push(`📅 Next slot: ${formatFrenchDate(nextSlot)}`);
        }

        if (msgLines.length > 2) { // Only send meaningful messages
            const msg = msgLines.join("\n");
            console.log(msg);
            await sendTelegram(msg);
        }

        // Update lastSlots safely
        lastSlots[key].notifiedSlots.push(...newSlotsNormalized.map(normalizeSlot));
        lastSlots[key].notifiedSlots = [...new Set(lastSlots[key].notifiedSlots)];
        lastSlots[key].next_slot = nextSlot;

        saveLastSlots(lastSlots);
    }

    // Random delay 8–12 min
    const delay = Math.floor(Math.random() * (12 - 8 + 1) + 8) * 60_000;
    console.log(`⏱ Waiting ${Math.floor(delay / 60000)} min until next check...\n`);
    setTimeout(checkAllEndpoints, delay);
};

// --------------------
// Start
// --------------------
checkAllEndpoints();