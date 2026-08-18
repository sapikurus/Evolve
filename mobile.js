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

        // 2) Subtitles as plain text UNDERNEATH each button (sibling div, not inside it).
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
