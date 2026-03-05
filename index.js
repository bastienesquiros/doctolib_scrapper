import puppeteer from "puppeteer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import {URL} from "url";
import "dotenv/config";

// --------------------
// Config
// --------------------

const STATE_FILE = path.join(process.cwd(), "doctolib_state.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SEARCH_URLS = [
    "https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14",
    "https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14"
];

// --------------------
// Utils
// --------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveState(data) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function formatFrenchDate(isoString) {
    const date = new Date(isoString);

    return date.toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function parseUrl(url) {
    const u = new URL(url);

    return {
        city: u.searchParams.get("location")?.toUpperCase() || "UNKNOWN",
        keyword: u.searchParams.get("keyword")?.toUpperCase() || "UNKNOWN"
    };
}

async function sendTelegram(message) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) {
        console.warn("⚠️ Telegram not configured");
        return;
    }

    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    chat_id: CHAT_ID,
                    text: message
                })
            }
        );

        const data = await res.json();

        if (!data.ok) {
            console.error("❌ Telegram error:", data);
        }
    } catch (err) {
        console.error("❌ Telegram request failed:", err);
    }
}

// --------------------
// Puppeteer helpers
// --------------------

async function autoScroll(page) {
    let previousHeight = 0;

    while (true) {
        const height = await page.evaluate(() => document.body.scrollHeight);

        if (height === previousHeight) break;

        previousHeight = height;

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

        await sleep(1500);
    }
}

async function getAvailabilityEndpoints() {
    const endpointMap = new Map();

    const browser = await puppeteer.launch({
        headless: "new"
    });

    for (const searchUrl of SEARCH_URLS) {
        const page = await browser.newPage();

        page.on("request", (req) => {
            const url = req.url();

            if (url.includes("/search/availabilities.json")) {
                endpointMap.set(url, searchUrl);
            }
        });

        await page.goto(searchUrl, {waitUntil: "networkidle2"});

        await autoScroll(page);

        await page.close();
    }

    await browser.close();

    return endpointMap;
}

// --------------------
// Fetch JSON
// --------------------

async function fetchSlots(jsonUrl) {
    try {

        const url = new URL(jsonUrl);

        const agendaId = url.searchParams.get("agenda_ids");

        const res = await fetch(jsonUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        if (res.status === 429 || res.status === 403) {
            console.warn("⚠️ Rate limited, waiting 60s...");
            await sleep(60000);
            return {slots: [], nextSlot: null};
        }

        const data = await res.json();

        const availabilities = data.availabilities || [];

        const slots = [];

        for (const entry of availabilities) {
            for (const slot of entry.slots || []) {

                const normalized = slot.slice(0, 16);

                slots.push({
                    id: `${agendaId}_${normalized}`,
                    agendaId,
                    date: slot
                });

            }
        }

        return {
            slots,
            nextSlot: data.next_slot || null
        };

    } catch (err) {
        console.error("💥 Fetch error:", err);

        return {slots: [], nextSlot: null};
    }
}

// --------------------
// Main logic
// --------------------

async function checkAllEndpoints() {
    const state = loadState();

    const endpointMap = await getAvailabilityEndpoints();

    const groupMap = new Map();

    for (const [jsonUrl, searchUrl] of endpointMap.entries()) {
        const {slots, nextSlot} = await fetchSlots(jsonUrl);

        if (!slots.length && !nextSlot) continue;

        const {city, keyword} = parseUrl(searchUrl);

        const key = `${city} | ${keyword}`;

        if (!groupMap.has(key)) {
            groupMap.set(key, {
                slots: [],
                nextSlot: null,
                searchUrl
            });
        }

        const entry = groupMap.get(key);

        entry.slots.push(...slots);

        if (
            !entry.nextSlot ||
            (nextSlot && new Date(nextSlot) < new Date(entry.nextSlot))
        ) {
            entry.nextSlot = nextSlot;
        }
    }

    // --------------------
    // Send notifications
    // --------------------

    for (const [key, group] of groupMap.entries()) {
        if (!state[key]) {
            state[key] = {
                notifiedSlots: [],
                next_slot: null
            };
        }

        const notified = new Set(state[key].notifiedSlots);

        const newSlots = group.slots.filter((s) => !notified.has(s.id));

        if (!newSlots.length && state[key].next_slot === group.nextSlot) {
            console.log(`ℹ️ No new slots for ${key}`);
            continue;
        }

        let message = `🩺 ${key}\n`;
        message += `🔗 ${group.searchUrl}\n`;

        if (newSlots.length) {
            message += "\n🚨 New slots:\n";

            for (const slot of newSlots.slice(0, 10)) {
                message += `- ${formatFrenchDate(slot.date)} (agenda ${slot.agendaId})\n`;
            }
        }

        if (group.nextSlot) {
            message += `\n📅 Next slot: ${formatFrenchDate(group.nextSlot)}\n`;
        }

        console.log(message);

        await sendTelegram(message);

        for (const slot of newSlots) {
            notified.add(slot.id);
        }

        state[key].notifiedSlots = [...notified];
        state[key].next_slot = group.nextSlot;
    }

    saveState(state);

    // --------------------
    // Next run
    // --------------------

    const delay = (8 + Math.random() * 4) * 60 * 1000;

    console.log(`⏱ Next check in ${Math.round(delay / 60000)} minutes\n`);

    setTimeout(checkAllEndpoints, delay);
}

// --------------------

checkAllEndpoints();