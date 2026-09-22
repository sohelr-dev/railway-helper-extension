/* =========================================================
   Railway Ticket Helper — popup.js  (v3.0)
   Popup UI button handlers, config persistence and
   message exchange with the content script.
   ========================================================= */

/* ---------- DOM references ---------- */
const startBtn = document.getElementById('startBtn');
const statusBox = document.getElementById('status');

// Inputs
const fromStation = document.getElementById('fromStation');
const toStation = document.getElementById('toStation');
const journeyDate = document.getElementById('journeyDate');
const coachCode = document.getElementById('coachCode');
const seatPreference = document.getElementById('seatPreference');
const seatCount = document.getElementById('seatCount');
const speedMs = document.getElementById('speedMs');

let isRunning = false;

/* ---------- Helper functions ---------- */

function setStatus(message, type = 'info') {
    statusBox.textContent = message;
    statusBox.className = 'status' + (type === 'info' ? '' : ' ' + type);
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

/** Send a message to the content script in the active tab (safely). */
async function sendToContent(message) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
        setStatus('No active tab found.', 'err');
        return null;
    }
    if (!/railway\.gov\.bd/.test(tab.url || '')) {
        setStatus('Please open eticket.railway.gov.bd first.', 'warn');
        return null;
    }
    try {
        return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
        setStatus('Could not reach the content script -- refresh the page.', 'err');
        return null;
    }
}

/** Update the icon/UI running state. */
function renderRunningState(running) {
    isRunning = running;
    startBtn.textContent = running ? 'Stop Auto-Booking' : 'Start Auto-Booking';
    startBtn.classList.toggle('active', running);
}

/** Build a config object from every popup input. */
function collectConfig() {
    return {
        from: fromStation.value.trim(),
        to: toStation.value.trim(),
        date: journeyDate.value,
        coach: coachCode.value.trim().toUpperCase(),  // empty means all coaches
        seatPreference: seatPreference.value,
        seatCount: Math.max(1, parseInt(seatCount.value, 10) || 1),
        speedMs: parseInt(speedMs.value, 10) || 150
    };
}

/* ---------- Initial load: saved settings + state ---------- */

document.addEventListener('DOMContentLoaded', async () => {
    const saved = await chrome.storage.local.get([
        'from', 'to', 'date', 'coach', 'seatPreference',
        'seatCount', 'speedMs', 'isRunning'
    ]);

    if (saved.from) fromStation.value = saved.from;
    if (saved.to) toStation.value = saved.to;
    if (saved.date) journeyDate.value = saved.date;
    if (saved.coach) coachCode.value = saved.coach;
    if (saved.seatPreference) seatPreference.value = saved.seatPreference;
    if (saved.seatCount) seatCount.value = saved.seatCount;
    if (saved.speedMs) speedMs.value = String(saved.speedMs);
    renderRunningState(!!saved.isRunning);

    const state = await sendToContent({ type: 'GET_STATUS' });
    if (state && state.running) {
        renderRunningState(true);
        setStatus('Auto-booking is running...', 'ok');
    }
});

/* ---------- Save settings automatically ---------- */

function persistConfig() {
    chrome.storage.local.set(collectConfig());
}

[fromStation, toStation, journeyDate, coachCode, seatPreference, seatCount, speedMs]
    .forEach((el) => el.addEventListener('change', persistConfig));

// Save once typing stops in the text inputs (debounce)
let persistTimer = null;
[fromStation, toStation, coachCode].forEach((el) => {
    el.addEventListener('input', () => {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persistConfig, 400);
    });
});

/* ---------- Save settings automatically ---------- */

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
        if (!isRunning) {
            const config = collectConfig();
            chrome.storage.local.set(config);
            setStatus(
                `Starting auto-booking (${config.speedMs}ms loop, coach: ${config.coach || 'ALL'})...`
            );
            const res = await sendToContent({
                type: 'START_AUTO_BOOKING',
                config: config
            });
            if (res && res.ok) {
                renderRunningState(true);
                chrome.storage.local.set({ isRunning: true });
                setStatus('Auto-booking started -- scanning for free seats at high speed...', 'ok');
            } else if (res) {
                setStatus(res.message || 'Could not start.', 'err');
            }
        } else {
            setStatus('Stopping auto-booking...');
            await sendToContent({ type: 'STOP_AUTO_BOOKING' });
            renderRunningState(false);
            chrome.storage.local.set({ isRunning: false });
            setStatus('Auto-booking stopped.', 'warn');
        }
    } finally {
        startBtn.disabled = false;
    }
});

/* ---------- Listen for status updates from the content script ---------- */

chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.source !== 'railway-helper-content') return;

    if (msg.type === 'STATUS_UPDATE') {
        setStatus(msg.message, msg.level || 'info');
    }
    if (msg.type === 'AUTO_BOOKING_STOPPED') {
        renderRunningState(false);
        chrome.storage.local.set({ isRunning: false });
    }
    // On reaching the OTP page, stop the loop and focus that tab
    if (msg.type === 'REDIRECT_TO_OTP') {
        renderRunningState(false);
        chrome.storage.local.set({ isRunning: false });
        setStatus('📱 Reached the OTP page -- opening it now.', 'warn');
        focusOtpTab(msg.url);
    }
});

/** Focus the OTP page (only activates the tab if it is the same one). */
async function focusOtpTab(url) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            await chrome.tabs.update(tab.id, { active: true });
            if (url) await chrome.tabs.update(tab.id, { url: url });
        }
    } catch (e) { /* ignore */ }
}