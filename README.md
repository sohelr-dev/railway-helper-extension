# Railway Ticket Helper

A Chrome extension (Manifest V3) that automates booking on the **Bangladesh Railway e-ticket site** — [eticket.railway.gov.bd](https://eticket.railway.gov.bd). It auto-fills the search form, finds a train/class with free seats, selects seats at high speed, and stops on the OTP page so you can complete verification.

> **Version:** 4.0

---

## Features

- **Auto search** — fills From / To / Date / Class and either navigates directly to the site's search URL or fills the form and clicks *Search Trains*.
- **Auto Book Now** — on the results page, picks the train/class with free seats (preferring your chosen class) and clicks *Book Now*.
- **Lightning seat selection** — scans the seat layout, selects the coach with available seats, and clicks only free seats. Supports a fast configurable scan loop.
- **Seat preferences** — target *Window*, *Aisle*, *Lower berth*, or *Upper berth* seats, or any available seat.
- **OTP handling** — detects the OTP / verification page, stops the automation loop, and focuses that tab so you can enter the code.
- **Persistent settings** — all inputs are saved to `chrome.storage.local` and restored every time the popup opens.
- **Auto-resume** — after a page reload the content script reads the saved state and resumes if auto-booking was running.
- **Safety limit** — the loop stops automatically after 15 minutes of runtime.

---

## Project structure

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3 configuration: permissions, host permissions, and the content script registration. |
| `content.js` | The automation engine — page detection, search form filling, Book Now, coach/seat selection, and OTP redirect. |
| `popup.html` | The popup UI and styling (route, date, coach/class, seat preference, seat count, scan speed). |
| `popup.js` | Popup logic — collects config, persists it to storage, and exchanges messages with the content script. |

---

## Installation (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. The **Railway Ticket Helper** icon appears in the toolbar.

---

## Usage

1. Open [eticket.railway.gov.bd](https://eticket.railway.gov.bd) in the active tab.
2. Click the extension icon to open the popup.
3. Fill in the fields:
   - **From** / **To** — station names (e.g. `Dhaka`, `Saidpur`).
   - **Journey Date** — pick a date.
   - **Coach / class code** — e.g. `SNIGDHA`, `S_CHAIR`, `AC_B`… leave blank for any class.
   - **Seat Preference** — any / window / aisle / lower / upper.
   - **How many seats** — 1 to 4.
   - **Speed loop** — scan interval: Lightning 100 ms, Ultra 150 ms, Fast 250 ms, Normal 500 ms.
4. Click **Start Auto-Booking**.
5. The extension searches, books, and selects seats automatically. When the OTP page is reached, the loop stops and that tab is focused — enter your OTP to finish.

Click **Stop Auto-Booking** at any time to halt the loop.

---

## Configuration

Tunable constants live at the top of `content.js` inside the `CONFIG` object — element selectors, keyword lists, scan intervals, click cooldown, and the max runtime. Adjust these if the target site changes its markup or class names.

---

## Permissions

| Permission | Why it is needed |
|------------|------------------|
| `activeTab` | Access the currently active tab. |
| `scripting` | Inject and run automation logic. |
| `storage` | Persist your settings and running state. |
| `tabs` | Query and focus the active / OTP tab. |
| `host_permissions` (`*.railway.gov.bd`) | Operate only on the Bangladesh Railway ticket site. |

---

## Disclaimer

This project is intended for **personal use and learning**. Use it responsibly and in accordance with the ticket site's terms of service. The author is not responsible for any misuse or consequences arising from using this extension.
