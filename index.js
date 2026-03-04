import puppeteer from "puppeteer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {URL} from "url";
import 'dotenv/config';

// --------------------
// Config
// --------------------
const STATE_FILE = path.join(process.cwd(), "lastSlots.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SEARCH_URLS = ["https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14", "https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14"];

// --------------------
// Utils
// --------------------
function loadLastSlots() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveLastSlots(data) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function formatFrenchDate(isoString) {
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
}

function parseUrl(url) {
    const u = new URL(url);
    const city = u.searchParams.get("location")?.toUpperCase() || "UNKNOWN";
    const keyword = u.searchParams.get("keyword").toUpperCase() || "UNKNOWN";
    return {city, keyword};
}

async function sendTelegram(message) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return console.warn("⚠️ Telegram token/Chat ID not set in .env");
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({chat_id: CHAT_ID, text: message}),
        });
        const data = await res.json();
        if (!data.ok) console.error("❌ Telegram error:", data);
    } catch (err) {
        console.error("❌ Fetch error:", err);
    }
}

function hashSlots(slots) {
    return crypto.createHash("md5").update(slots.join(",")).digest("hex");
}

// --------------------
// Puppeteer helpers
// --------------------
async function autoScroll(page) {
    let totalHeight = 0;
    const distance = 300;
    while (true) {
        const scrollHeight = await page.evaluate("document.body.scrollHeight");
        await page.evaluate(`window.scrollBy(0, ${distance})`);
        totalHeight += distance;
        await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
        if (totalHeight >= scrollHeight) break;
    }
    await new Promise(r => setTimeout(r, 3000));
}

async function getAvailabilityEndpoints() {
    const endpointMap = new Map();
    for (const searchUrl of SEARCH_URLS) {
        const browser = await puppeteer.launch({
            headless: "new",
        });
        const page = await browser.newPage();
        page.on("request", request => {
            const reqUrl = request.url();
            if (reqUrl.includes("/search/availabilities.json")) {
                endpointMap.set(reqUrl, searchUrl);
            }
        });
        await page.goto(searchUrl, {waitUntil: "networkidle2"});
        await autoScroll(page);
        await browser.close();
    }
    return endpointMap;
}

// --------------------
// Fetch JSON & extract slots
// --------------------
async function fetchSlots(jsonUrl) {
    try {
        const res = await fetch(jsonUrl, {headers: {"User-Agent": "Mozilla/5.0"}});
        const data = await res.json();
        if (res.status === 429 || res.status === 403 || (data.error && data.error.toLowerCase().includes("try again later"))) {
            console.warn(`⚠️ Rate limited on ${jsonUrl}. Waiting before next attempt...`);
            await new Promise(r => setTimeout(r, 60_000));
            return {slots: [], nextSlot: null};
        }
        const slots = data.availabilities?.flatMap(d => d.slots || []) || [];
        const nextSlot = data.next_slot || null;
        return {slots, nextSlot};
    } catch (err) {
        console.error(`💥 Error fetching ${jsonUrl}:`, err);
        return {slots: [], nextSlot: null};
    }
}

// --------------------
// Main loop
// --------------------
async function checkAllEndpoints() {
    const lastSlots = loadLastSlots();
    const endpointMap = await getAvailabilityEndpoints();

    const groupMap = new Map(); // key = city + keyword

    for (const [jsonUrl, searchUrl] of endpointMap.entries()) {
        const {slots, nextSlot} = await fetchSlots(jsonUrl);
        if (!slots.length && !nextSlot) continue;

        const {city, keyword} = parseUrl(searchUrl);
        const key = `${city} | ${keyword}`;

        if (!groupMap.has(key)) groupMap.set(key, {
            slots: [], nextSlot: null, searchUrl
        });

        const entry = groupMap.get(key);
        entry.slots.push(...slots);
        if (!entry.nextSlot || (nextSlot && new Date(nextSlot) < new Date(entry.nextSlot))) {
            entry.nextSlot = nextSlot;
        }
    }

    // Send one message per group
    for (const [key, {slots, nextSlot, searchUrl}] of groupMap.entries()) {
        const currentHash = hashSlots(slots);

        if (lastSlots[key]?.hash === currentHash && lastSlots[key]?.next_slot === nextSlot) {
            console.log(`ℹ️ No new slots for ${key}`);
            continue;
        }

        let msgLines = [`🩺 ${key}`, `🔗 Doctolib: ${searchUrl}`];

        if (slots.length) {
            msgLines.push("🚨 New slots available:\n" + slots.map(s => `- ${formatFrenchDate(s)}`).join("\n"));
        }
        if (nextSlot) {
            msgLines.push(`📅 Next slot: ${formatFrenchDate(nextSlot)}`);
        }

        const msg = msgLines.join("\n");
        console.log(msg);
        await sendTelegram(msg);

        lastSlots[key] = {slots, next_slot: nextSlot, hash: currentHash};
        saveLastSlots(lastSlots);
    }

    const delay = Math.floor(Math.random() * (12 - 8 + 1) + 8) * 60_000;
    console.log(`⏱ Waiting ${Math.floor(delay / 60000)} min until next check...\n`);
    setTimeout(checkAllEndpoints, delay);
}

// --------------------
// Start
// --------------------
checkAllEndpoints();