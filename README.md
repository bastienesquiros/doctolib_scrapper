# 🩺 Doctolib Availability Scrapper

A **Node.js CLI scrapper** that tracks available doctor appointments on Doctolib and sends notifications via Telegram (optional). Works for **any city, specialty, or search filter** 🌍✨

---

## 🚀 Features

- 🏙️ Track multiple **cities** at once
- 👨‍⚕️ Works for any **specialty** or **search filter** (`availabilitiesBefore`, `insuranceSector`, `regulationSector`, etc.)
- 📅 Notifies about **new appointment slots** per city
- 🔁 Avoids **duplicate alerts** using persistent state storage
- 🚫 **Blacklist** specific agenda IDs you don't want to be notified about
- 💬 Optional **Telegram notifications**
- 🖥️ Fully automated in the **CLI**
- 🤖 Handles **rate limiting** and **page errors** gracefully with automatic retries

---

## ⚙️ Requirements

- Node.js v20+
- npm
- Telegram account (optional)

---

## 📥 Installation

1. Clone the repo:

```bash
git clone https://github.com/besquiros/doctolib-scrapper.git
cd doctolib-scrapper
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file (ignored by git):

```env
TELEGRAM_TOKEN=your_bot_token_here
CHAT_ID=your_chat_id_here

# Optional: comma-separated agenda IDs to silence
BLACKLISTED_AGENDA_IDS=123456,789012
```

If you skip `.env`, the scraper will just log updates in the terminal.

---

## 🛠️ Configuration

Edit `SEARCH_URLS` in `index.js` to track any search:

```js
const SEARCH_URLS = [
  "https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14",
  "https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14",
];
```

Works for any city, specialty, or Doctolib filter — just copy a search URL directly from the Doctolib website.

The scraper groups notifications by city & specialty.

---

## ⚡ Usage

```bash
npm start
# or
node index.js
```

It will:

1. Launch a headless browser for each search URL
2. Scrape JSON endpoints for available appointment slots
3. Compare with `doctolib_state.json` to avoid duplicates
4. Send one Telegram message per city/specialty with all new slots
5. Repeat every 8–12 minutes (randomized to avoid rate limits)

---

## 🚫 Blacklist

To silence a specific doctor/agenda, add their agenda ID to your `.env`:

```env
BLACKLISTED_AGENDA_IDS=123456,789012
```

The agenda ID appears in every console/Telegram notification: `(agenda 123456)`.
Blacklisted slots are still logged to the console but never sent to Telegram.
The blacklist is re-read every cycle — no restart needed after editing `.env`.

---

## 💬 Telegram Integration

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather)
2. Copy the bot token → `.env TELEGRAM_TOKEN`
3. Send a message to your bot once, then check your chat ID:
   `https://api.telegram.org/bot<token>/getUpdates`
4. Paste chat ID in `.env CHAT_ID`

---

## 🐳 Docker (recommended)

Docker avoids Node version issues and runs the scraper in an isolated environment.

```bash
# Build
docker build -t doctolib-scrapper .

# Run
docker run -d --env-file .env --restart unless-stopped doctolib-scrapper
```

> ⚠️ Running on a VPS may not work — VPS IPs are often blocked by Cloudflare.

---

## 🗂️ Project Structure

```
doctolib-scrapper/
├── index.js               # Main scraper script
├── doctolib_state.json    # Auto-generated, tracks notified slots
├── package.json
├── Dockerfile
├── .env                   # Telegram token & chat ID (gitignored)
└── README.md
```

---

## 📝 Example Output

Console:
```
🩺 TOULOUSE | DERMATOLOGUE
🔗 https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14

🚨 New slots:
- jeudi 5 mars 2026 à 09:45 (agenda 1653547)
- jeudi 5 mars 2026 à 11:45 (agenda 1653547)

⏱ Next check in 10 minutes
```

Blacklisted agenda:
```
🚫 [TOULOUSE | DERMATOLOGUE] 3 slot(s) blacklisté(s) ignorés (agendas: 129685)
```

---

## ⚠️ Notes & Tips

- You can use any valid Doctolib search URL, including filters like `insuranceSector`, `regulationSector`, etc.
- To keep it running continuously outside Docker: use `pm2`, `screen`, or `tmux`
- Never share your `.env` or `doctolib_state.json` publicly — they are user-specific

---

## ⚖️ Disclaimer

This project is provided **for educational and personal use only** 🧑‍💻📚.

- Do **not use this scraper for commercial purposes** or to overload Doctolib's servers.
- The author is **not responsible for any misuse** of this tool.
- Always respect the **Terms of Service of Doctolib**.

Use responsibly and at your own risk ⚠️

---

## 🏷️ License

MIT — free to use, modify, and share

