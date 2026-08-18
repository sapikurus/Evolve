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
})();
