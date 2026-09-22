/* =========================================================
   Railway Ticket Helper - content.js  (v4.0)
   1) Search form auto-fill (From / To / Date) -> SEARCH TRAINS
   2) Search-results page (next page): pick train/class with free seats, Book Now
   3) Seat layout page: pick coach, click only available seats
   4) OTP page: stop the loop and redirect straight to the OTP page
   ========================================================= */

(() => {
    'use strict';

    /* ---------- CONFIG (adjust here if the site changes classes/text) ---------- */
    const CONFIG = {
        /* ===== Home page search form ===== */
        // Real site: <input id="dest_from" name="dest_from" formcontrolname="fromcity">
        fromInputSelectors: [
            '#dest_from', 'input[name="dest_from"]',
            'input[formcontrolname="fromcity"]', '#from_station'
        ],
        toInputSelectors: [
            '#dest_to', 'input[name="dest_to"]',
            'input[formcontrolname="tocity"]', '#to_station'
        ],
        // Date: #doj is readonly + jQuery datepicker, paired with hidden formcontrolname="doj"
        dateInputSelectors: ['#doj', 'input[name="doj"]'],
        hiddenDateSelectors: ['input[formcontrolname="doj"]'],
        // "Choose Class" dropdown (AC_B, SNIGDHA, S_CHAIR ...)
        classSelectors: ['#choose_class', 'select[formcontrolname="class"]'],
        // Station suggestions from the jQuery UI autocomplete widget
        suggestionSelectors: [
            'ul.ui-autocomplete li.ui-menu-item a',
            'ul.ui-autocomplete li.ui-menu-item',
            'li.ui-menu-item'
        ],
        searchBtnSelectors: ['button.search-button', '#trainsearch button[type="submit"]'],
        searchBtnTexts: ['search trains', 'search'],

        /* ===== Seat layout (real site) ===== */
        availableSeatSelectors: ['.seat-available', 'button.seat-available'],
        coachDropdownSelectors: ['#select-bogie', 'select[id*="bogie" i]'],
        coachOptionPattern: /^\s*(.+?)\s*-\s*(\d+)\s*seat/i,
        seatButtonSelectors: ['#tbl_seat_list button', 'button[title]'],
        seatSoldKeywords: ['seat-booked', 'seat-disabled', 'seat-in-progress', 'seat-hidden', 'sold', 'unavailable', 'booked', 'reserved'],
        seatFreeKeywords: ['seat-available', 'available', 'free'],

        /* ===== Results page (next page) -> Book Now ===== */
        seatClassCardSelectors: ['.single-seat-class'],
        bookNowBtnSelectors: ['.book-now-btn'],
        proceedTexts: ['book now', 'continue', 'proceed', 'next', 'confirm'],
        proceedIdKeywords: ['book-now', 'continue', 'proceed', 'next', 'confirm'],

        /* ===== OTP page detection (redirect only) ===== */
        otpInputSelectors: [
            'input.rec-otp', 'input[name="otp"]', 'input[name*="otp" i]',
            'input[id*="otp" i]', 'input[placeholder*="otp" i]'
        ],
        otpUrlPattern: /otp|verify|verification/i,

        windowKeywords: ['window', 'win', 'janala'],
        aisleKeywords: ['aisle', 'middle'],
        lowerKeywords: ['lower', 'lb', 'l_b'],
        upperKeywords: ['upper', 'ub', 'u_b'],

        SCAN_INTERVAL_MS: 250,
        SEAT_CLICK_COOLDOWN_MS: 400,
        MAX_RUNTIME_MS: 15 * 60 * 1000
    };

    /* ---------- Runtime state (popup config is applied here) ---------- */
    const state = {
        from: '',
        to: '',
        date: '',
        coach: '',
        seatPreference: 'any',
        seatCount: 1,
        speedMs: CONFIG.SCAN_INTERVAL_MS
    };

    /* ---------- à¦¸à§à¦Ÿà§‡à¦Ÿ ---------- */
    let scanTimer = null;
    let startedAt = 0;
    let running = false;
    let lastClickAt = 0;
    let proceedScheduled = false;
    let selectedCount = 0;
    let pausedForOtp = false;
    let lastCoachSignature = '';
    const clickedSeats = new WeakSet();
    let selectionDone = false;
    let pendingSeatCoach = '';
    let searchSubmitted = false;
    let resultSubmitted = false;
    /* ---------- Helpers ---------- */

    function log() {
        console.log.apply(console, ['[Railway Helper]'].concat(Array.prototype.slice.call(arguments)));
    }

    /** Send a status line to the popup (silently no-ops if it is closed). */
    function report(message, level) {
        level = level || 'info';
        log(message);
        try {
            chrome.runtime.sendMessage({
                source: 'railway-helper-content',
                type: 'STATUS_UPDATE',
                message: message,
                level: level
            });
        } catch (e) { /* no receiver when the popup is closed */ }
    }

    function isVisible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    }

    /** Lower-cases an element's class/id/title/data/text into one string. */
    function signatureText(el) {
        var cls = (el.className || '').toString().toLowerCase();
        var id = (el.id || '').toString().toLowerCase();
        var title = (el.getAttribute && el.getAttribute('title') || '').toString().toLowerCase();
        var attrs = Array.prototype.slice.call(el.attributes || [])
            .map(function (a) { return a.name + '=' + a.value; }).join(' ').toLowerCase();
        var text = (el.textContent || '').trim().toLowerCase();
        return cls + ' + id + ' + title + ' + attrs + ' + text;
    }

    /** Whether an element is already sold/booked. */
    function isSold(el) {
        if (!el) return true;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return true;
        var sig = signatureText(el);
        if (CONFIG.seatFreeKeywords.some(function (kw) { return sig.indexOf(kw) !== -1; })) return false;
        return CONFIG.seatSoldKeywords.some(function (kw) { return sig.indexOf(kw) !== -1; });
    }

    /** Whether an element is a genuinely clickable available seat. */
    function isAvailableSeat(el) {
        if (!isVisible(el)) return false;
        return !isSold(el);
    }

    /** Match a seat against the user's seat preference. */
    function matchesPreference(el) {
        var pref = state.seatPreference;
        if (!pref || pref === 'any') return true;
        var groups = {
            window: CONFIG.windowKeywords,
            aisle: CONFIG.aisleKeywords,
            lower: CONFIG.lowerKeywords,
            upper: CONFIG.upperKeywords
        };
        var keywords = groups[pref];
        if (!keywords) return true;
        var sig = signatureText(el);
        return keywords.some(function (kw) { return sig.indexOf(kw) !== -1; });
    }

    /* ---------- Click / input helpers ---------- */

    /** Click an element, dispatching mouse events so the site's JS reacts. */
    function clickElement(el) {
        if (!el) return;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { }
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
            try {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (e) { }
        });
        if (typeof el.click === 'function') el.click();
    }

    /** Set a value on an Angular/React controlled input, with events. */
    function setNativeValue(input, value) {
        if (!input) return;
        try {
            var proto = Object.getPrototypeOf(input);
            var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(input, value);
            else input.value = value;
        } catch (e) { input.value = value; }
        ['keydown', 'keypress', 'input', 'keyup', 'change', 'blur'].forEach(function (type) {
            try { input.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) { }
        });
    }

    /** Return the first visible element from a list of selectors. */
    function firstVisible(selectors) {
        for (var i = 0; i < selectors.length; i++) {
            var nodes = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < nodes.length; j++) {
                if (isVisible(nodes[j])) return nodes[j];
            }
        }
        return null;
    }

    function isDisabled(el) {
        if (!el) return true;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return true;
        var cls = (el.className || '').toString().toLowerCase();
        return CONFIG.seatSoldKeywords.some(function (kw) { return cls.indexOf(kw) !== -1; });
    }

    /* =========================================================
       1) Search form auto-fill (From / To / Date -> SEARCH TRAINS)
       ========================================================= */

    /**
     * Convert a date to the site's real format: dd-Mon-yyyy (e.g. 25-Sep-2026).
     * Accepts either 2026-09-25 or 25-Sep-2026 and yields the same result.
     */
    function toSiteDate(dateStr) {
        var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var m = (dateStr || '').trim().match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) {
            var day = parseInt(m[3], 10);
            var mon = parseInt(m[2], 10) - 1;
            if (mon >= 0 && mon < 12) {
                return day + '-' + MONTHS[mon] + '-' + m[1];
            }
        }
        // Already dd-Mon-yyyy: leave it untouched
        return (dateStr || '').trim();
    }

    /**
     * Build the site's own search URL -- far more reliable than
     * typing/autocomplete. Format (confirmed from the real URL):
     *   /booking/train/search?fromcity=Dhaka&tocity=Saidpur&doj=25-Sep-2026&class=S_CHAIR
     */
    function buildSearchUrl() {
        if (!state.from || !state.to || !state.date) return null;
        var params = 'fromcity=' + encodeURIComponent(state.from) +
            '&tocity=' + encodeURIComponent(state.to) +
            '&doj=' + encodeURIComponent(toSiteDate(state.date));
        if (state.coach) {
            params += '&class=' + encodeURIComponent(state.coach.toUpperCase());
        }
        return '/booking/train/search?' + params;
    }

    /** Whether we are already on the real site's search page. */
    function isOnSearchPage() {
        return /\/booking\/train\/search/i.test(location.pathname + location.search);
    }

    function findSearchForm() {
        var fromEl = firstVisible(CONFIG.fromInputSelectors);
        var toEl = firstVisible(CONFIG.toInputSelectors);
        if (!fromEl || !toEl || fromEl === toEl) return null;
        return { fromEl: fromEl, toEl: toEl };
    }

    function findDateInput() {
        var el = firstVisible(CONFIG.dateInputSelectors);
        return el && el.tagName === 'INPUT' ? el : null;
    }

    function findSearchButton() {
        for (var i = 0; i < CONFIG.searchBtnSelectors.length; i++) {
            var el = document.querySelector(CONFIG.searchBtnSelectors[i]);
            if (el && isVisible(el)) return el;
        }
        var candidates = Array.prototype.slice.call(
            document.querySelectorAll('button, input[type="submit"]'));
        return candidates.filter(function (el) {
            if (!isVisible(el)) return false;
            var text = (el.textContent || el.value || '').trim().toLowerCase();
            return CONFIG.searchBtnTexts.some(function (t) { return text.indexOf(t) !== -1; });
        })[0] || null;
    }

    /** Click the matching entry in the jQuery UI station autocomplete list. */
    function pickStationSuggestion(input, name) {
        var target = name.trim().toLowerCase();
        if (!target) return false;

        var items = [];
        CONFIG.suggestionSelectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (el) {
                if (isVisible(el)) items.push(el);
            });
        });
        if (!items.length) return false;

        // Exact name match first, then a partial match
        var exact = items.filter(function (el) {
            return (el.textContent || '').trim().toLowerCase() === target;
        })[0];
        var partial = items.filter(function (el) {
            var t = (el.textContent || '').trim().toLowerCase();
            return t.indexOf(target) !== -1;
        })[0];

        var match = exact || partial;
        if (match) {
            // In jQuery UI the real clickable element is the inner <a>
            var clickable = match.querySelector('a') || match;
            clickElement(clickable);
            return true;
        }
        return false;
    }

    /** Type a name character by character, then pick the suggestion. */
    function fillStationInput(input, name) {
        if (!input || !name) return false;
        try { input.focus(); } catch (e) { }
        setNativeValue(input, '');
        var typed = '';
        for (var i = 0; i < name.length; i++) {
            typed += name[i];
            setNativeValue(input, typed);
        }
        setTimeout(function () {
            if (pickStationSuggestion(input, name)) {
                log('Station suggestion selected:', name);
            } else {
                setNativeValue(input, name.trim());
            }
        }, 400);
        return true;
    }

    /**
     * Set the date. On the real site #doj is readonly + a jQuery datepicker,
     * so we write it directly and also set the hidden formcontrolname="doj".
     */
    function fillDateInput(dateStr) {
        if (!dateStr) return false;
        var ok = false;

        // The site's real format: dd-Mon-yyyy (e.g. 25-Sep-2026)
        var display = toSiteDate(dateStr);

        var el = findDateInput();
        if (el) {
            try { el.removeAttribute('readonly'); } catch (e) { }
            setNativeValue(el, display);
            try { el.setAttribute('value', display); } catch (e) { }
            ok = true;
        }

        // Same format goes into Angular's hidden input too
        CONFIG.hiddenDateSelectors.forEach(function (selector) {
            var hidden = document.querySelector(selector);
            if (hidden) setNativeValue(hidden, display);
        });

        return ok;
    }

    /** Select the user's class in the "Choose Class" dropdown, if present. */
    function fillClassDropdown() {
        if (!state.coach) return false;
        for (var i = 0; i < CONFIG.classSelectors.length; i++) {
            var sel = document.querySelector(CONFIG.classSelectors[i]);
            if (!sel || sel.tagName !== 'SELECT') continue;
            var target = normalizeCoach(state.coach);
            var opt = Array.prototype.slice.call(sel.options).filter(function (o) {
                return normalizeCoach(o.value) === target || normalizeCoach(o.textContent) === target;
            })[0];
            if (opt) {
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
        }
        return false;
    }

    /**
     * Navigate straight to the site's search URL (the most reliable path).
     * Falls back to filling the form when the URL cannot be built.
     */
    function navigateToSearch() {
        var url = buildSearchUrl();
        if (!url) {
            // Date/station incomplete -- fall back to filling the form
            searchSubmitted = autoFillSearchForm();
            return;
        }
        searchSubmitted = true;
        report('🔎 Going to search URL: ' + decodeURIComponent(url), 'ok');
        location.href = url;
    }

    /**
     * Fill the home page search form and click SEARCH TRAINS (fallback).
     * Returns false when there is no form (i.e. another page).
     */
    function autoFillSearchForm() {
        var form = findSearchForm();
        if (!form) return false;

        if (!state.from || !state.to) {
            if (!searchSubmitted) {
                searchSubmitted = true;  // avoid reporting this over and over
                report('⚠️ Enter the From / To station names in the popup -- then it will search.', 'warn');
            }
            return false;
        }

        var fromOk = (form.fromEl.value || '').trim().length > 0;
        var toOk = (form.toEl.value || '').trim().length > 0;

        if (!fromOk) fillStationInput(form.fromEl, state.from);
        if (!toOk) fillStationInput(form.toEl, state.to);
        if (state.date) fillDateInput(state.date);
        fillClassDropdown();   // coach code == class, so pick "Choose Class" too

        report('📝 Filling search form: ' + state.from + ' -> ' + state.to +
            (state.date ? ' (' + state.date + ')' : ''), 'info');

        setTimeout(function () {
            if (!running) return;
            var btn = findSearchButton();
            if (btn) {
                clickElement(btn);
                searchSubmitted = true;
                report('🔎 Clicked SEARCH TRAINS -- heading to the results page...', 'ok');
            } else {
                report('SEARCH TRAINS button not found.', 'warn');
            }
        }, 900);

        return true;
    }

    /* =========================================================
       2) Results page (next page) -> Book Now on a train that has free seats
       ========================================================= */

    function hasSearchResults() {
        return document.querySelectorAll('.single-trip-wrapper, .single-seat-class').length > 0;
    }

    /** Read the number of free seats from a seat-class card. */
    function seatClassAvailability(card) {
        if (!card) return 0;
        var box = card.querySelector('.online-seats .all-seats') ||
            card.querySelector('.all-seats') ||
            card.querySelector('.seat-availability-box');
        if (!box) return 0;
        var text = (box.textContent || '').replace(/\s+/g, ' ').trim();
        var m = text.match(/(\d+)/);
        if (!m) return 0;
        var n = parseInt(m[1], 10);
        return isFinite(n) ? n : 0;
    }

    /** Click "Book Now" on a suitable train/class. True when it succeeded. */
    function clickBookNow() {
        if (!hasSearchResults()) return false;

        var cards = Array.prototype.slice.call(document.querySelectorAll('.single-seat-class'));
        if (!cards.length) return false;

        var preferred = state.coach ? normalizeCoach(state.coach) : '';
        var scored = cards.map(function (card) {
            var btn = card.querySelector('.book-now-btn');
            var free = seatClassAvailability(card);
            // The class name lives in its own span (AC_S, SNIGDHA, S_CHAIR ...)
            var nameEl = card.querySelector('.seat-class-name');
            var className = nameEl ? nameEl.textContent : '';
            var matchesCoach = !preferred ||
                normalizeCoach(className).indexOf(preferred) !== -1;
            return {
                card: card, btn: btn, free: free,
                className: (className || '').trim(), matchesCoach: matchesCoach
            };
        }).filter(function (c) {
            return c.btn && c.free > 0 && !c.btn.hasAttribute('disabled');
        });

        if (!scored.length) {
            report('No free seats in the results yet -- waiting...', 'warn');
            return false;
        }

        scored.sort(function (a, b) {
            if (a.matchesCoach !== b.matchesCoach) return a.matchesCoach ? -1 : 1;
            return b.free - a.free;
        });

        var chosen = scored[0];
        clickElement(chosen.btn);
        report('🎫 Selected class ' + (chosen.className || '') + ' (free seats: ' +
            chosen.free + ') -- loading the seat layout...', 'ok');
        return true;
    }

    /* =========================================================
       3) Seat layout page -- coach selection and clicking free seats
       ========================================================= */

    /** Find the "Select Coach" dropdown element. */
    function findCoachDropdown() {
        for (var i = 0; i < CONFIG.coachDropdownSelectors.length; i++) {
            var el = document.querySelector(CONFIG.coachDropdownSelectors[i]);
            if (el && el.tagName === 'SELECT' && el.options && el.options.length) {
                var hasSeatCount = Array.prototype.slice.call(el.options).some(function (o) {
                    return CONFIG.coachOptionPattern.test((o.textContent || '').trim());
                });
                if (hasSeatCount) return el;
            }
        }
        return null;
    }

    /** [{ code, seats }] from the dropdown -- only coaches with free seats. */
    function readCoachOptions() {
        var sel = findCoachDropdown();
        if (!sel) return null;
        var out = [];
        Array.prototype.slice.call(sel.options).forEach(function (opt) {
            var m = (opt.textContent || '').trim().match(CONFIG.coachOptionPattern);
            if (!m) return;
            var seats = parseInt(m[2], 10);
            if (seats > 0) out.push({ code: m[1].trim().toUpperCase(), seats: seats });
        });
        return out;
    }

    /** Canonicalise a coach code (S-CHAIR == S_CHAIR == SCHAIR). */
    function normalizeCoach(code) {
        return (code || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    /** Whether a coach name matches the user-supplied coach code. */
    function coachMatches(name) {
        if (!state.coach) return true;
        var target = normalizeCoach(state.coach);
        if (!target) return true;
        var actual = normalizeCoach(name);
        return actual === target || actual.indexOf(target) !== -1 || target.indexOf(actual) !== -1;
    }

    /** Collect free seats from the real site's grid (button[title]). */
    function findSeatButtons() {
        var seats = [];
        var seen = new Set();
        var selectors = CONFIG.seatButtonSelectors.concat(CONFIG.availableSeatSelectors);
        selectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (el) {
                if (seen.has(el)) return;
                seen.add(el);
                if (!isAvailableSeat(el)) return;
                var title = (el.getAttribute('title') || '').trim();
                if (!title && el.className.toString().indexOf('seat-available') === -1) return;
                seats.push({ el: el, coach: '', seat: title });
            });
        });
        return seats;
    }

    /** Select a suitable coach from the dropdown; returns the coach code. */
    function selectCoachFromDropdown() {
        var dropdown = findCoachDropdown();
        if (!dropdown) return null;

        var options = readCoachOptions();
        if (!options || !options.length) return null;

        var chosen;
        if (state.coach) {
            var target = normalizeCoach(state.coach);
            chosen = options.filter(function (o) { return normalizeCoach(o.code) === target; })[0] ||
                options.filter(function (o) {
                    return normalizeCoach(o.code).indexOf(target) !== -1 ||
                        target.indexOf(normalizeCoach(o.code)) !== -1;
                })[0];
            if (!chosen) return null;
        } else {
            chosen = options.slice().sort(function (a, b) { return b.seats - a.seats; })[0];
        }

        var current = dropdown.options[dropdown.selectedIndex];
        if (current && normalizeCoach((current.textContent || '').split('-')[0]) === normalizeCoach(chosen.code)) {
            return chosen.code;
        }

        var opt = Array.prototype.slice.call(dropdown.options).filter(function (o) {
            var m = (o.textContent || '').trim().match(CONFIG.coachOptionPattern);
            return m && normalizeCoach(m[1]) === normalizeCoach(chosen.code);
        })[0];
        if (!opt) return null;

        dropdown.value = opt.value;
        dropdown.dispatchEvent(new Event('change', { bubbles: true }));
        dropdown.dispatchEvent(new Event('input', { bubbles: true }));
        return chosen.code;
    }

    /** Find up to `limit` free seats (all of them when no limit is given). */
    function scanAvailableSeats(limit, excludeClicked) {
        var cap = (typeof limit === 'number' && limit > 0) ? limit : Infinity;
        var all = findSeatButtons();
        var result = [];

        for (var i = 0; i < all.length && result.length < cap; i++) {
            var entry = all[i];
            if (excludeClicked && clickedSeats.has(entry.el)) continue;
            if (!matchesPreference(entry.el)) continue;
            result.push(entry);
        }

        // No seats but a dropdown exists: pick the right coach, seats appear next scan
        if (result.length === 0 && findCoachDropdown()) {
            var picked = selectCoachFromDropdown();
            if (picked) pendingSeatCoach = picked;
        }

        return result.slice(0, cap);
    }

    /** A summary string of the coaches (reported only when it changes). */
    function coachSummary() {
        var opts = readCoachOptions();
        if (opts && opts.length) {
            return opts.map(function (o) { return o.code + '(' + o.seats + ')'; }).join(', ');
        }
        var seats = document.querySelectorAll('#tbl_seat_list button').length;
        if (seats) return 'Seat grid: ' + seats + ' seats';
        return 'no seat grid';
    }

    /* =========================================================
       4) OTP page -- stop the loop and go straight to the OTP page
       ========================================================= */

    /** Whether this page is the OTP / verification page. */
    function isOtpPage() {
        if (CONFIG.otpUrlPattern.test(location.pathname + location.search + location.hash)) {
            return true;
        }
        for (var i = 0; i < CONFIG.otpInputSelectors.length; i++) {
            var el = document.querySelector(CONFIG.otpInputSelectors[i]);
            if (el && isVisible(el)) return true;
        }
        return false;
    }

    /** On reaching the OTP page, stop the loop and focus that page. */
    function redirectToOtpPageIfPresent() {
        if (pausedForOtp) return false;
        if (!isOtpPage()) return false;

        pausedForOtp = true;
        report('📱 Reached the OTP page -- auto loop stopped. Opening the OTP page...', 'warn');
        redirectToOtp();
        return true;
    }

    /** Ensure the OTP page is focused/redirected in the same tab. */
    function redirectToOtp() {
        try {
            chrome.runtime.sendMessage({
                source: 'railway-helper-content',
                type: 'REDIRECT_TO_OTP',
                url: location.href
            }, function () { });
        } catch (e) { }
        setTimeout(function () {
            try { window.focus(); } catch (e) { }
        }, 200);
    }

    /* =========================================================
       5) Main automation loop -- detects which step the page is on
       ========================================================= */

    function scanAndSelectSeat() {
        if (!running || pausedForOtp || selectionDone) return;

        // Safety: stop automatically after a fixed runtime
        if (Date.now() - startedAt > CONFIG.MAX_RUNTIME_MS) {
            stop('Time is up -- auto-booking stopped itself.');
            return;
        }

        // (a) OTP page? stop the loop and go straight there
        if (redirectToOtpPageIfPresent()) return;

        // (b) Home page search form -- go straight to the search URL (more reliable than typing)
        if (findSearchForm() && !isOnSearchPage()) {
            if (!searchSubmitted) navigateToSearch();
            return;
        }

        // (c) Seat grid present? selecting seats is now the main job
        if (findSeatGrid()) {
            selectSeatsFromGrid();
            return;
        }

        // (d) Results page (next page) -- click Book Now on a class with free seats
        if (hasSearchResults()) {
            if (!resultSubmitted && clickBookNow()) resultSubmitted = true;
            return;
        }

        report('Waiting -- the page is still loading...', 'info');
    }

    /** Whether the seat grid has loaded (the real site renders it inline). */
    function findSeatGrid() {
        return document.querySelector(
            '.seat-layout-view #select-bogie, .seat_layout .btn-seat, #tbl_seat_list button'
        );
    }

    /** Pick a coach and click the required number of free seats. */
    function selectSeatsFromGrid() {
        var summary = coachSummary();
        if (summary !== lastCoachSignature) {
            lastCoachSignature = summary;
            report('Coach scan: ' + summary, 'info');
        }

        var need = state.seatCount - selectedCount;
        if (need <= 0) {
            selectionDone = true;
            scheduleProceed();
            return;
        }

        var seats = scanAvailableSeats(need, true);
        if (seats.length === 0) {
            if (selectedCount > 0) return;
            report('No free seats -- selecting a coach from the dropdown to load seats...', 'info');
            return;
        }

        // cooldown: a short pause so the page JS can settle
        if (Date.now() - lastClickAt < CONFIG.SEAT_CLICK_COOLDOWN_MS) return;

        var picked = seats.slice(0, need);
        lastClickAt = Date.now();

        picked.forEach(function (s) {
            clickedSeats.add(s.el);
            clickElement(s.el);
            selectedCount++;
        });

        var where = pendingSeatCoach ? ' (coach ' + pendingSeatCoach + ')' : '';
        var seatNos = picked.map(function (s) { return s.seat; }).filter(Boolean).join(', ');
        report('⚡ Selected ' + picked.length + ' free seat(s)' + where +
            (seatNos ? ' -- seats: ' + seatNos : '') +
            ' -- total ' + selectedCount + '/' + state.seatCount + '.', 'ok');

        if (selectedCount >= state.seatCount) {
            selectionDone = true;
            scheduleProceed();
        }
    }

    /** Schedule the Proceed click (once), retrying if it fails. */
    function scheduleProceed() {
        if (proceedScheduled) return;
        proceedScheduled = true;
        var attempt = function (triesLeft) {
            if (!running) return;
            var done = clickProceed();
            if (!done && triesLeft > 0) setTimeout(function () { attempt(triesLeft - 1); }, 500);
        };
        setTimeout(function () { attempt(6); }, 500);
    }

    /** Find and click Continue / Proceed / Next / Book Now. */
    function clickProceed() {
        if (!running) return false;

        // The seat grid page's real button: button.continue-btn (CONTINUE PURCHASE)
        var continueBtn = document.querySelector(
            '.continue-btn, #confirmbooking button[type="submit"], .btn-close-seat-layout');
        if (continueBtn && continueBtn.classList.contains('btn-close-seat-layout')) {
            continueBtn = null;   // never the "Close" button
        }
        if (continueBtn && isVisible(continueBtn) && !continueBtn.hasAttribute('disabled')) {
            clickElement(continueBtn);
            report('➡️ Clicked CONTINUE PURCHASE -- moving to the next step.', 'ok');
            return true;
        }

        for (var i = 0; i < CONFIG.bookNowBtnSelectors.length; i++) {
            var btn = document.querySelector(CONFIG.bookNowBtnSelectors[i]);
            if (btn && isVisible(btn) && !btn.hasAttribute('disabled')) {
                clickElement(btn);
                report('➡️ Clicked Book Now -- moving to the next step.', 'ok');
                return true;
            }
        }

        var candidates = Array.prototype.slice.call(document.querySelectorAll(
            'button, input[type="submit"], a.btn, a.button, [role="button"]'));

        var target = candidates.filter(function (el) {
            if (!isVisible(el) || isDisabled(el)) return false;
            var text = (el.textContent || el.value || '').trim().toLowerCase();
            // Never click MODIFY SEARCH / PREV. DAY / CLOSE by mistake
            if (text.indexOf('modify') !== -1) return false;
            if (text.indexOf('close') !== -1) return false;
            if (text.indexOf('prev') !== -1 || text.indexOf('next day') !== -1) return false;
            var idc = (el.id + ' ' + el.className).toLowerCase();
            return CONFIG.proceedTexts.some(function (t) { return text.indexOf(t) !== -1; }) ||
                CONFIG.proceedIdKeywords.some(function (t) { return idc.indexOf(t) !== -1; });
        })[0];

        if (target) {
            clickElement(target);
            report('➡️ Clicked Continue/Proceed -- moving to the next step.', 'ok');
            return true;
        }
        report('No Continue button found -- seat selection is complete.', 'warn');
        return false;
    }

    /* ---------- Start / stop ---------- */

    /** Apply the config received from the popup. */
    function applyConfig(config) {
        if (!config) return;
        state.from = (config.from || '').toString().trim();
        state.to = (config.to || '').toString().trim();
        state.date = (config.date || '').toString().trim();
        state.coach = (config.coach || '').toString().trim().toUpperCase();
        state.seatPreference = config.seatPreference || 'any';
        state.seatCount = Math.max(1, parseInt(config.seatCount, 10) || 1);
        state.speedMs = Math.max(50, parseInt(config.speedMs, 10) || CONFIG.SCAN_INTERVAL_MS);
    }

    function start(options) {
        options = options || {};
        if (running) return { ok: true, message: 'Already running.', running: true };

        applyConfig(options.config);
        pausedForOtp = false;
        proceedScheduled = false;
        selectedCount = 0;
        selectionDone = false;
        lastCoachSignature = '';
        pendingSeatCoach = '';
        searchSubmitted = false;
        resultSubmitted = false;
        startedAt = Date.now();
        lastClickAt = 0;
        running = true;

        report('🚀 Auto-booking started -- ' + (state.from || '?') + ' -> ' + (state.to || '?') +
            (state.date ? ' (' + state.date + ')' : '') +
            ', coach: ' + (state.coach || 'ALL') + ', seats: ' + state.seatCount, 'ok');

        scanTimer = setInterval(scanAndSelectSeat, state.speedMs);
        scanAndSelectSeat();
        return { ok: true, message: 'Auto-booking started.', running: true };
    }

    function stop(message) {
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        running = false;
        report(message || 'Auto-booking stopped.', 'warn');
        try {
            chrome.runtime.sendMessage({
                source: 'railway-helper-content',
                type: 'AUTO_BOOKING_STOPPED'
            });
        } catch (e) { }
        return { ok: true, running: false };
    }

    /* ---------- Message handling from the popup ---------- */

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || !msg.type) return;

        if (msg.type === 'START_AUTO_BOOKING') {
            sendResponse(start({ config: msg.config }));
            return;
        }
        if (msg.type === 'STOP_AUTO_BOOKING') {
            sendResponse(stop());
            return;
        }
        if (msg.type === 'GET_STATUS') {
            sendResponse({ ok: true, running: running, onOtpPage: isOtpPage() });
            return;
        }
    });

    /* ---------- Restart from saved settings after an auto-reload ---------- */

    (async function () {
        try {
            var saved = await chrome.storage.local.get([
                'from', 'to', 'date', 'coach', 'seatPreference',
                'seatCount', 'speedMs', 'isRunning'
            ]);
            applyConfig(saved);
            if (isOtpPage()) {
                log('OTP page -- did not start the auto loop.');
            } else if (saved.isRunning) {
                log('Saved state found -- resuming auto-booking.');
                start({ config: saved });
            }
        } catch (e) {
            log('Could not load settings:', e);
        }
    })();

    log('Content script loaded (v4.0).');
})();
