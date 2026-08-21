/* Evolve Advisor — a live, rule-based "what to do next" panel.
 * Reads the game's own save from localStorage, decodes it with the
 * LZString library the game already loads, and surfaces the most
 * actionable issues: capped storage wasting production, idle citizens,
 * power/support shortfalls, and stalled build/research queues.
 *
 * Drop-in: no edits to the game's own source. Load it AFTER the game
 * scripts in index.html:  <script src="advisor.js" defer></script>
 *
 * Everything degrades gracefully: each rule feature-detects the fields
 * it needs, so a lighter/earlier save simply shows fewer cards.
 */
(function () {
  'use strict';

  var REFRESH_MS = 5000;     // how often to re-read the save
  var CAP_PCT = 0.98;        // "storage capped" threshold
  var NEAR_PCT = 0.90;       // "filling up" threshold
  var MIN_WASTE_DIFF = 0.5;  // ignore capped resources that aren't actually producing

  // ---- save loading -------------------------------------------------------

  // The game stores its save compressed under a localStorage key. Historically
  // 'evolved'. We try that first, then scan every key for anything that
  // LZString can decompress into an object with a .resource map — so the
  // advisor self-locates the key regardless of build.
  function getLZ() {
    return window.LZString || window.LZ || null;
  }

  function tryDecode(LZ, raw) {
    if (!raw || typeof raw !== 'string') return null;
    var json =
      LZ.decompressFromBase64(raw) ||
      LZ.decompressFromEncodedURIComponent(raw) ||
      LZ.decompress(raw);
    if (!json) return null;
    try {
      var obj = JSON.parse(json);
      return obj && obj.resource ? obj : null;
    } catch (e) {
      return null;
    }
  }

  function loadSave() {
    var LZ = getLZ();
    if (!LZ) return null;
    // Preferred key first.
    var preferred = ['evolved', 'evolve', 'save'];
    for (var i = 0; i < preferred.length; i++) {
      var s = tryDecode(LZ, localStorage.getItem(preferred[i]));
      if (s) return s;
    }
    // Fallback: scan everything.
    for (var j = 0; j < localStorage.length; j++) {
      var key = localStorage.key(j);
      var val = localStorage.getItem(key);
      var decoded = tryDecode(LZ, val);
      if (decoded) return decoded;
    }
    return null;
  }

  // ---- rules --------------------------------------------------------------
  // Each rule returns an array of {sev, title, detail} where sev is
  // 'warn' | 'info' | 'good'. Higher-severity cards sort to the top.

  var SEV_ORDER = { warn: 0, info: 1, good: 2 };

  function num(n) {
    if (n == null || isNaN(n)) return '0';
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toString();
  }

  function ruleCappedStorage(save) {
    var out = [];
    var res = save.resource || {};
    var capped = [];
    var filling = [];
    for (var k in res) {
      var r = res[k];
      if (!r || !r.display || typeof r.amount !== 'number' || !(r.max > 0)) continue;
      var pct = r.amount / r.max;
      var diff = typeof r.diff === 'number' ? r.diff : 0;
      if (pct >= CAP_PCT && diff >= MIN_WASTE_DIFF) {
        capped.push({ k: r.name || k, diff: diff });
      } else if (pct >= NEAR_PCT && pct < CAP_PCT && diff > 0) {
        filling.push({ k: r.name || k, pct: pct });
      }
    }
    if (capped.length) {
      capped.sort(function (a, b) { return b.diff - a.diff; });
      var names = capped.map(function (c) { return c.k + ' (+' + num(c.diff) + '/s)'; });
      out.push({
        sev: 'warn',
        title: capped.length + ' resource' + (capped.length > 1 ? 's' : '') + ' capped and wasting output',
        detail: 'At storage max with production still running: ' + names.join(', ') +
          '. Build more storage (warehouses / freight yards / the relevant depot), spend it, or turn off surplus producers.'
      });
    }
    if (filling.length) {
      filling.sort(function (a, b) { return b.pct - a.pct; });
      out.push({
        sev: 'info',
        title: filling.length + ' resource' + (filling.length > 1 ? 's' : '') + ' near cap',
        detail: 'Filling up: ' + filling.map(function (f) {
          return f.k + ' (' + Math.round(f.pct * 100) + '%)';
        }).join(', ') + '. Storage soon or it starts wasting.'
      });
    }
    return out;
  }

  function ruleKnowledgeCapped(save) {
    // Knowledge capped is special: it silently stalls all research.
    var res = save.resource || {};
    var kn = res.Knowledge;
    if (!kn || !kn.display || !(kn.max > 0)) return [];
    if (kn.amount / kn.max >= CAP_PCT && (kn.diff || 0) > 0) {
      return [{
        sev: 'warn',
        title: 'Knowledge capped — research is wasting',
        detail: 'Knowledge is at ' + num(kn.amount) + '/' + num(kn.max) + ' with +' +
          num(kn.diff) + '/s going nowhere. Buy a tech, or raise the cap (libraries / wardenclyffe / biolabs) so it stops overflowing.'
      }];
    }
    return [];
  }

  function ruleDraining(save) {
    var out = [];
    var res = save.resource || {};
    var drains = [];
    for (var k in res) {
      var r = res[k];
      if (!r || !r.display || typeof r.diff !== 'number') continue;
      if (r.diff < 0 && r.amount >= 0) {
        var secs = r.diff < 0 && r.amount > 0 ? Math.round(r.amount / -r.diff) : 0;
        drains.push({ k: r.name || k, diff: r.diff, secs: secs, empty: r.amount <= 0 });
      }
    }
    if (drains.length) {
      drains.sort(function (a, b) { return a.secs - b.secs; });
      out.push({
        sev: 'warn',
        title: drains.length + ' resource' + (drains.length > 1 ? 's' : '') + ' draining',
        detail: drains.map(function (d) {
          return d.empty ? d.k + ' (empty!)' : d.k + ' (~' + d.secs + 's left)';
        }).join(', ') + '. Add producers or cut consumption before it stalls dependent buildings.'
      });
    }
    return out;
  }

  function ruleIdleLabor(save) {
    var out = [];
    var civ = save.civic || {};
    var unemp = civ.unemployed;
    if (unemp && typeof unemp.workers === 'number' && unemp.workers > 0) {
      out.push({
        sev: 'info',
        title: unemp.workers + ' unemployed citizen' + (unemp.workers > 1 ? 's' : ''),
        detail: 'Idle population producing nothing. Assign them to a job (professors/scientists for research, miners for materials) or build jobs that need filling.'
      });
    }
    if (typeof civ.homeless === 'number' && civ.homeless > 0) {
      out.push({
        sev: 'warn',
        title: civ.homeless + ' homeless citizen' + (civ.homeless > 1 ? 's' : ''),
        detail: 'Not enough housing. Build houses / cottages / apartments to house and employ them.'
      });
    }
    // Job slots open but unfilled (workers < assigned target) across visible jobs.
    var understaffed = [];
    for (var k in civ) {
      var j = civ[k];
      if (!j || typeof j !== 'object' || j.job === 'unemployed') continue;
      if (typeof j.workers === 'number' && typeof j.assigned === 'number' &&
          j.assigned > j.workers) {
        understaffed.push((j.name || k) + ' (' + j.workers + '/' + j.assigned + ')');
      }
    }
    if (understaffed.length) {
      out.push({
        sev: 'info',
        title: 'Understaffed jobs',
        detail: understaffed.join(', ') + '. Not enough population to fill assigned slots — grow population or rebalance.'
      });
    }
    return out;
  }

  // Buildings that are very commonly left off on purpose (race choice, power
  // juggling, or strategic toggling). We don't flag these — flagging things the
  // player switched off deliberately is exactly what makes an advisor annoying.
  var OFTEN_OFF = {
    windmill: 1, mill: 1, metal_refinery: 1, rock_quarry: 1, sawmill: 1,
    casino: 1, tourist_center: 1, wardenclyffe: 1, biolab: 1, mine: 1,
    coal_mine: 1, oil_well: 1, compost: 1, cement_plant: 1, factory: 1,
    smelter: 1, replicator: 1, transmitter: 1
  };

  function rulePoweredOff(save) {
    // Buildings with count>0 but on<count are often deliberately switched off.
    // Only surface *large* shortfalls on buildings not on the "often off" list,
    // so this stays a signal, not noise.
    var out = [];
    var zones = ['city', 'space', 'interstellar', 'portal', 'eden', 'tauceti', 'galaxy'];
    var off = [];
    for (var z = 0; z < zones.length; z++) {
      var zone = save[zones[z]];
      if (!zone || typeof zone !== 'object') continue;
      for (var k in zone) {
        if (OFTEN_OFF[k]) continue;
        var b = zone[k];
        if (!b || typeof b !== 'object') continue;
        if (typeof b.count === 'number' && typeof b.on === 'number' &&
            b.count > 0 && b.on < b.count) {
          var gap = b.count - b.on;
          // Require the gap to be a meaningful fraction (>=50%) so a single
          // toggled-off unit among many doesn't trigger it.
          if (gap / b.count >= 0.5) {
            off.push({ name: k, gap: gap, count: b.count });
          }
        }
      }
    }
    if (off.length) {
      off.sort(function (a, b) { return b.gap - a.gap; });
      var top = off.slice(0, 5).map(function (o) {
        return o.name.replace(/_/g, ' ') + ' (' + (o.count - o.gap) + '/' + o.count + ')';
      });
      out.push({
        sev: 'info',
        title: off.length + ' building type' + (off.length > 1 ? 's' : '') + ' mostly off',
        detail: 'Largely switched off — likely a power or support shortfall (or intentional): ' +
          top.join(', ') + '. If unintended, add power/support or free up capacity.'
      });
    }
    return out;
  }

  function ruleQueues(save) {
    var out = [];
    var q = save.queue;
    var rq = save.r_queue;
    var bItems = q && q.queue ? q.queue.length : 0;
    var rItems = rq && rq.queue ? rq.queue.length : 0;
    if (q && q.pause) {
      out.push({ sev: 'info', title: 'Build queue paused', detail: 'Your construction queue is paused — nothing is building. Unpause when ready.' });
    }
    if (rq && rq.pause) {
      out.push({ sev: 'info', title: 'Research queue paused', detail: 'Your research queue is paused. Unpause to keep teching.' });
    }
    if (bItems === 0 && rItems === 0 && !(q && q.pause)) {
      out.push({
        sev: 'info',
        title: 'Queues empty',
        detail: 'Nothing queued to build or research. Line up the next building or tech so idle production converts into progress.'
      });
    } else if (bItems > 0 || rItems > 0) {
      out.push({
        sev: 'good',
        title: 'Queues active',
        detail: (bItems ? bItems + ' build' + (bItems > 1 ? 's' : '') : '') +
          (bItems && rItems ? ' · ' : '') +
          (rItems ? rItems + ' research' : '') + ' queued. Rolling along.'
      });
    }
    return out;
  }

  function runRules(save) {
    var cards = [];
    [ruleKnowledgeCapped, ruleCappedStorage, ruleDraining, ruleIdleLabor,
      ruleQueues, rulePoweredOff].forEach(function (rule) {
      try { cards = cards.concat(rule(save) || []); } catch (e) { /* rule-safe */ }
    });
    if (!cards.length) {
      cards.push({ sev: 'good', title: 'Nothing urgent', detail: 'No capped storage, draining resources, or idle citizens detected. Keep pushing your current objective.' });
    }
    cards.sort(function (a, b) { return SEV_ORDER[a.sev] - SEV_ORDER[b.sev]; });
    return cards;
  }

  // ---- UI -----------------------------------------------------------------

  var STYLE = [
    '#adv-panel{position:fixed;right:12px;bottom:12px;z-index:99999;width:320px;max-width:calc(100vw - 24px);',
      'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e6edf3;',
      'background:rgba(16,20,24,.96);border:1px solid #2a333b;border-radius:10px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.5);backdrop-filter:blur(4px);overflow:hidden}',
    '#adv-head{display:flex;align-items:center;gap:.5rem;padding:.55rem .7rem;cursor:pointer;',
      'background:linear-gradient(180deg,#141a1f,#0f1418);border-bottom:1px solid #2a333b;user-select:none}',
    '#adv-head .dot{width:8px;height:8px;border-radius:50%;background:#1abc9c;box-shadow:0 0 8px #1abc9c}',
    '#adv-head h3{margin:0;font-size:.86rem;font-weight:700;letter-spacing:.02em;flex:1}',
    '#adv-head .count{font-size:.72rem;color:#8fa1b3;background:#1f272e;border-radius:10px;padding:.05rem .45rem}',
    '#adv-head .chev{font-size:.7rem;color:#8fa1b3;transition:transform .15s}',
    '#adv-panel.collapsed .chev{transform:rotate(180deg)}',
    '#adv-body{max-height:52vh;overflow-y:auto;padding:.5rem}',
    '#adv-panel.collapsed #adv-body{display:none}',
    '.adv-card{border:1px solid #2a333b;border-left-width:3px;border-radius:7px;padding:.5rem .6rem;',
      'margin:.4rem 0;background:#191f25}',
    '.adv-card:first-child{margin-top:.1rem}',
    '.adv-card.warn{border-left-color:#e5534b}',
    '.adv-card.info{border-left-color:#f0a742}',
    '.adv-card.good{border-left-color:#1abc9c}',
    '.adv-card .t{font-size:.8rem;font-weight:600;margin:0 0 .2rem;line-height:1.25}',
    '.adv-card.warn .t{color:#ff8b84}',
    '.adv-card.info .t{color:#f6c073}',
    '.adv-card.good .t{color:#63d6bd}',
    '.adv-card .d{font-size:.73rem;color:#b7c3ce;line-height:1.4;margin:0}',
    '#adv-foot{padding:.4rem .7rem;border-top:1px solid #2a333b;font-size:.66rem;color:#6b7885;',
      'display:flex;justify-content:space-between;align-items:center}',
    '#adv-foot button{background:#1f272e;color:#b7c3ce;border:1px solid #2a333b;border-radius:5px;',
      'font-size:.66rem;padding:.2rem .5rem;cursor:pointer}',
    '#adv-foot button:active{transform:translateY(1px)}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('adv-style')) return;
    var s = document.createElement('style');
    s.id = 'adv-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function buildPanel() {
    var p = document.createElement('div');
    p.id = 'adv-panel';
    p.innerHTML =
      '<div id="adv-head">' +
        '<span class="dot"></span>' +
        '<h3>Advisor</h3>' +
        '<span class="count" id="adv-count">0</span>' +
        '<span class="chev">\u25BC</span>' +
      '</div>' +
      '<div id="adv-body"></div>' +
      '<div id="adv-foot"><span id="adv-status">reading save\u2026</span>' +
        '<button id="adv-refresh">Refresh</button></div>';
    document.body.appendChild(p);

    var head = p.querySelector('#adv-head');
    head.addEventListener('click', function () {
      p.classList.toggle('collapsed');
      try { localStorage.setItem('adv-collapsed', p.classList.contains('collapsed') ? '1' : '0'); } catch (e) {}
    });
    if (safeGet('adv-collapsed') === '1') p.classList.add('collapsed');

    p.querySelector('#adv-refresh').addEventListener('click', function (e) {
      e.stopPropagation();
      render();
    });
    return p;
  }

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    var body = document.getElementById('adv-body');
    var countEl = document.getElementById('adv-count');
    var statusEl = document.getElementById('adv-status');
    if (!body) return;

    var save = loadSave();
    if (!save) {
      body.innerHTML = '<div class="adv-card warn"><p class="t">No save found</p>' +
        '<p class="d">Couldn\u2019t read the game save from storage. Play a moment so the game writes a save, then hit Refresh.</p></div>';
      countEl.textContent = '!';
      if (statusEl) statusEl.textContent = 'no save';
      return;
    }

    var cards = runRules(save);
    var actionable = cards.filter(function (c) { return c.sev !== 'good'; }).length;
    countEl.textContent = actionable;
    countEl.style.background = actionable ? '#3a1f1f' : '#1f272e';
    countEl.style.color = actionable ? '#ff8b84' : '#8fa1b3';

    body.innerHTML = cards.map(function (c) {
      return '<div class="adv-card ' + c.sev + '">' +
        '<p class="t">' + esc(c.title) + '</p>' +
        '<p class="d">' + esc(c.detail) + '</p></div>';
    }).join('');

    if (statusEl) {
      var ver = save.version ? 'v' + save.version : '';
      var race = save.race && save.race.species ? ' \u00b7 ' + save.race.species : '';
      statusEl.textContent = 'updated ' + new Date().toLocaleTimeString() +
        (ver ? ' \u00b7 ' + ver : '') + race;
    }
  }

  // ---- boot ---------------------------------------------------------------

  function boot() {
    if (document.getElementById('adv-panel')) return;
    injectStyle();
    buildPanel();
    render();
    setInterval(render, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
