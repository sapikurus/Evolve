/* Mobile helpers for Evolve.
   On touch devices there is no hover, so tooltip-only info is invisible.
   This surfaces the Attack success assessment and the Spy cost
   (both live in the buttons' `label` attribute) as visible subtitles. */
(function () {
    if (!window.matchMedia || !matchMedia('(max-width: 48rem), (pointer: coarse)').matches) {
        return;
    }

    function subText(btn, txt) {
        // Attack: label is already short, e.g. "45.3% advantage"
        if (btn.classList.contains('attack')) {
            return txt;
        }
        // Spy: label is a sentence — extract just the cost token, e.g. "$1,234"
        var m = txt.match(/\$\s?[\d.,]*\d\s?[a-zA-Z]?/);
        if (m) {
            return m[0].replace(/[.,]$/, '');
        }
        return txt;
    }

    function tick() {
        var btns = document.querySelectorAll('#foreign button.attack[label], #foreign .tspy button[label]');
        for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            var txt = btn.getAttribute('label');
            if (!txt) { continue; }
            var sub = btn.querySelector('.m-sub');
            if (!sub) {
                sub = document.createElement('span');
                sub.className = 'm-sub';
                btn.appendChild(sub);
            }
            var val = subText(btn, txt);
            if (sub.textContent !== val) {
                sub.textContent = val;
            }
        }
    }

    setInterval(tick, 700);
    document.addEventListener('DOMContentLoaded', tick);
    tick();
})();
