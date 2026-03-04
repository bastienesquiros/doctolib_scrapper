# 🩺 Doctolib Availability Scrapper

A **Node.js CLI scrapper** that tracks available doctor appointments on Doctolib and sends notifications via Telegram (
optional). Works for **any city, specialty, or search filter** 🌍✨

---

## 🚀 Features

- 🏙️ Track multiple **cities** at once
- 👨‍⚕️ Works for any **specialty** or **search filter** (`availabilitiesBefore`,`insuranceSector`, `regulationSector`,
  etc.)
- 📅 Notifies about **new appointment slots** per city
- 🔁 Avoids **duplicate alerts** using hash storage
- 💬 Optional **Telegram notifications**
- 🖥️ Fully automated in the **CLI**
- 🤖 Handles **rate limiting** gracefully

---

## ⚙️ Requirements

- Node.js v20+
- npm or yarn
- Telegram account (optional)

---

## 📥 Installation

1. Clone the repo:

```bash
git clone https://github.com/besquiros/doctolib-scrapper.git
cd doctolib-scrapper
```

2. Install dependencies:

```
npm install
```

3. Create a .env file (ignored by git):

```
TELEGRAM_TOKEN=your_bot_token_here
CHAT_ID=your_chat_id_here
```

If you skip .env, the scraper will just log updates in the terminal.

---

## 🛠️ Configuration

1. Edit SEARCH_URLS in index.js to track any search:

```
const SEARCH_URLS = [
"https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse&availabilitiesBefore=14",
"https://www.doctolib.fr/search?keyword=dermatologue&location=bordeaux&availabilitiesBefore=14&insuranceSector=all&regulationSector%5B%5D=CONTRACTED_1_WITH_EXTRA",
];
```

Works for any city, specialty, or Doctolib filter, generate a search url directly from Doctolib website

The scraper will group notifications by search URL / city & specialty

Last seen slots are stored in lastSlots.json (auto-generated). You can .gitignore it.

### ⚡ Usage

* Run the scraper:

```
node index.js
```

It will:

1. Launch a headless browser for each search URL

2. Scrape JSON endpoints for available appointment slots

3. Compare with lastSlots.json to avoid duplicates

4. Send one Telegram message per city and specialty with all new slots

5. Repeat every 8–12 minutes (randomized to avoid rate limits)

---

## 💬 Telegram Integration

1. Create a Telegram bot with @BotFather

2. Copy the bot token → .env TELEGRAM_TOKEN

3. Send a message to your bot once, then check your chat ID:

4. https://api.telegram.org/bot<token>/getUpdates

5. Paste chat ID in .env CHAT_ID

Each user needs their own bot token. Never share your bot token publicly! 🚫

---

## 🗂️ Project Structure

```
doctolib-scraper/
├─ index.js # Main scraper script
├─ lastSlots.json # Auto-generated storage for last seen slots
├─ package.json
├─ .env # Telegram token & chat ID (gitignored)
└─ README.md
```

---

## ⚠️ Notes & Tips

* You can use any valid Doctolib search URL, including filters like insuranceSector, regulationSector, etc.

* Running multiple cities/specialties: just add more URLs to SEARCH_URLS

* To keep it running continuously, use pm2, screen, or tmux

* Avoid sharing lastSlots.json publicly; it’s user-specific

---

## 📝 Example Telegram Message

```
🩺 TOULOUSE | Dermatologue
🔗 Doctolib: https://www.doctolib.fr/search?keyword=dermatologue&location=toulouse
🚨 New slots available:
- jeudi 5 mars 2026 à 09:45
- jeudi 5 mars 2026 à 11:45
📅 Next slot: mardi 10 mars 2026 à 12:00
```

## 🛠️ Contributing & Running in Docker

#### 💡 Contributions welcome!

Feel free to fork, commit, open issues, or suggest new features. Pull requests are always appreciated!

#### 🐳 Docker recommended for easy setup and consistent environment:

- Build the image:

```
docker build -t doctolib-scrapper .
```

- Run the container:

```
docker run -d --env-file .env doctolib-scrapper
```

The scraper will run automatically inside the container and send notifications if configured.

⚠️ Make sure your .env file is mounted or copied into the container to provide Telegram credentials.

🧑‍💻 Running in Docker avoids node version issues, dependency problems, or conflicts with your local machine.


---

## 🏷️ License

MIT — free to use, modify, and share

---

## ⚖️ Disclaimer

This project is provided **for educational and personal use only** 🧑‍💻📚.

- Do **not use this scraper for commercial purposes** or to overload Doctolib’s servers.
- The author is **not responsible for any misuse** of this tool.
- Always respect the **Terms of Service of Doctolib**.
- This project is intended to **learn web scraping, automation, and notifications**, not to replace or interfere with
  the platform.

Use responsibly and at your own risk ⚠️