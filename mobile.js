(function () {
    if (!window.matchMedia || !matchMedia('(max-width: 48rem), (pointer: coarse)').matches) { return; }

    function subText(btn, txt) {
        // Attack buttons: full battle assessment text (e.g. "85.4% advantage").
        if (btn.classList.contains('attack')) { return txt; }
        // Spy / espionage buttons: just the cost (e.g. "$1,482").
        var m = txt.match(/\$\s?[\d.,]*\d\s?[a-zA-Z]?/);
        return m ? m[0].replace(/[.,]$/, '') : txt;
    }

    function tick() {
        // 1) Relocate the Foreign Powers block from Civics > Government into Civics > Military.
        //    The game builds #foreign into the government pane; moving the DOM node keeps Vue
        //    bindings and event listeners intact. Guarded so it survives tab rebuilds.
        var foreign = document.querySelector('#foreign');
        var mil = document.querySelector('#military');
        if (foreign && mil) {
            if (foreign.parentElement !== mil || mil.lastElementChild !== foreign) {
                mil.appendChild(foreign);
            }
        }

        // 2) Scroll janitor: the game locks the page with html.is-clipped
        //    (overflow:hidden) while a modal is open; if the modal was torn
        //    down without cleanup the lock sticks and nothing can scroll.
        var root = document.documentElement;
        if (root.classList.contains('is-clipped') && !document.querySelector('.modal.is-active, .b-modal.is-active, .dialog.is-active')) {
            root.classList.remove('is-clipped');
        }
        if (root.style.overflow === 'hidden' && !document.querySelector('.modal.is-active')) {
            root.style.overflow = '';
        }
        if (document.body && document.body.style.overflow === 'hidden' && !document.querySelector('.modal.is-active')) {
            document.body.style.overflow = '';
        }

        // 3) Job / crafter steppers: replace « » glyphs with − +
        var steps = document.querySelectorAll('.sub > span, .add > span');
        for (var s = 0; s < steps.length; s++) {
            var t = steps[s].textContent;
            if (t === '\u00AB') { steps[s].textContent = '\u2212'; }
            else if (t === '\u00BB') { steps[s].textContent = '+'; }
        }

        // 4) Message log becomes a "Logs" sub-tab under Stats, so the top
        //    banner space is freed but the full log stays one tap away.
        var stats = document.querySelector('#mTabStats');
        var mq = document.querySelector('#msgQueue');
        if (stats && mq) {
            var navUl = stats.querySelector(':scope > .b-tabs > nav.tabs > ul') || stats.querySelector('.tabs > ul');
            var section = stats.querySelector(':scope > .b-tabs > section.tab-content') || stats.querySelector('section.tab-content');
            if (navUl && section) {
                var pane = document.getElementById('mLogsPane');
                if (!pane) {
                    pane = document.createElement('div');
                    pane.id = 'mLogsPane';
                    pane.className = 'tab-item';
                    section.appendChild(pane);
                }
                if (mq.parentElement !== pane) {
                    pane.appendChild(mq);
                }
                if (!navUl.querySelector('.m-logs-li')) {
                    var li = document.createElement('li');
                    li.className = 'm-logs-li';
                    var a = document.createElement('a');
                    a.textContent = 'Logs';
                    li.appendChild(a);
                    navUl.appendChild(li);
                    // Visibility is driven by the .m-logs-open class on the section
                    // (CSS !important hides Vue's panes) so Vue's own v-show state
                    // is never disturbed and restores itself on the way back.
                    a.addEventListener('click', function (e) {
                        e.preventDefault();
                        var lis = navUl.querySelectorAll('li');
                        for (var x = 0; x < lis.length; x++) { lis[x].classList.remove('is-active'); }
                        li.classList.add('is-active');
                        section.classList.add('m-logs-open');
                    });
                    navUl.addEventListener('click', function (e) {
                        var t = e.target.closest('li');
                        if (t && !t.classList.contains('m-logs-li')) {
                            section.classList.remove('m-logs-open');
                            li.classList.remove('is-active');
                        }
                    }, true);
                }
            }
        }

        // 5) Subtitles as plain text UNDERNEATH each button (sibling div, not inside it).
        var btns = document.querySelectorAll('#foreign button.attack[label], #foreign .tspy button[label]');
        for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            var txt = btn.getAttribute('label');
            if (!txt) { continue; }
            var sub = btn._msub;
            if (!sub || !sub.isConnected) {
                sub = document.createElement('div');
                sub.className = 'm-sub';
                btn._msub = sub;
            }
            if (btn.nextSibling !== sub) {
                btn.parentNode.insertBefore(sub, btn.nextSibling);
            }
            var val = subText(btn, txt);
            if (sub.textContent !== val) { sub.textContent = val; }
        }
    }
    setInterval(tick, 700);
    document.addEventListener('DOMContentLoaded', tick);
    tick();

    /* ---------- Offline / background catch-up ----------
       Mobile browsers freeze the whole tab (including the game's web worker
       timer) as soon as you leave the page, so production simply stops.
       We remember when the game was last alive, and when the page becomes
       visible again (or boots after being killed) we fast-forward:
         - up to 10 minutes: replay real game ticks via the game's own loop
         - longer: add per-second net production (diff) * elapsed, clamped to
           storage max (capped at 12 hours of gains) */
    var SEEN_KEY = 'm_seen';
    var MAX_OFFLINE = 12 * 3600; // 12h cap

    function markSeen() {
        try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) {}
    }

    function applyAway() {
        try {
            var g = window.__evolveRaw;
            if (!g || !g.resource) { return; }
            var seen = parseInt(localStorage.getItem(SEEN_KEY) || '0', 10);
            markSeen();
            if (!seen) { return; }
            var elapsed = Math.floor((Date.now() - seen) / 1000);
            if (elapsed < 90) { return; } // ignore quick tab flips
            if (elapsed > MAX_OFFLINE) { elapsed = MAX_OFFLINE; }
            if (elapsed <= 600 && typeof window.__evolveCp === 'function') {
                // Real simulation: 4 fast ticks per second of game time,
                // replayed in chunks so the UI stays responsive.
                var ticks = elapsed * 4;
                var runChunk = function () {
                    if (ticks <= 0) { return; }
                    var n = Math.min(ticks, 600);
                    ticks -= n;
                    try { window.__evolveCp(n); } catch (e) { ticks = 0; return; }
                    if (ticks > 0) { setTimeout(runChunk, 30); }
                };
                runChunk();
                return;
            }
            // Long absence: approximate with per-second net rates.
            for (var r in g.resource) {
                var res = g.resource[r];
                if (!res || !res.display || typeof res.amount !== 'number') { continue; }
                var rate = typeof res.diff === 'number' ? res.diff : 0;
                if (rate <= 0) { continue; }
                var gain = rate * elapsed;
                if (gain <= 0) { continue; }
                res.amount += gain;
                if (typeof res.max === 'number' && res.max >= 0 && res.amount > res.max) {
                    res.amount = res.max;
                }
            }
        } catch (e) {}
    }
    window.__applyAway = applyAway;

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { markSeen(); } else { applyAway(); }
    });
    window.addEventListener('pagehide', markSeen);
    // Heartbeat so we have a recent timestamp even if the browser kills
    // the page without firing any events.
    setInterval(function () { if (!document.hidden) { markSeen(); } }, 5000);
    // Boot-time catch-up (browser killed the tab while away): run after the
    // game has loaded its save.
    var bootTries = 0;
    var bootTimer = setInterval(function () {
        bootTries++;
        if (window.__evolveRaw) { applyAway(); clearInterval(bootTimer); }
        else if (bootTries > 40) { clearInterval(bootTimer); }
    }, 500);
})();
