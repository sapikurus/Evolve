/* Evolve Advisor v3 — live, rule-based helper injected into the game.
 *
 * Two tabs:
 *   ALERTS — live issues: capped storage, draining resources, stalled
 *            queue items (with the bottleneck resource named), idle labor.
 *   CHAIN  — a dependency reference for derived resources (what feeds what),
 *            annotated live with your current rate/stock so you can see which
 *            input is the constraint.
 *
 * Reads the game's own save from localStorage, decoded with the LZString the
 * game already loads. No edits to game source. Load AFTER the game scripts:
 *   <script src="advisor.js?v=3" defer></script>
 */
(function () {
  'use strict';

  var REFRESH_MS = 5000;
  var CAP_PCT = 0.98;
  var MIN_WASTE_DIFF = 0.5;

  // The game ships wiki.html at the site root; it supports #category deep-links.
  // Relative path keeps it correct on GitHub Pages' /Evolve/ subpath.
  var WIKI_URL = 'wiki.html';

  // ======================================================================
  // DERIVED-RESOURCE DEPENDENCY MAP
  // Verified against the Evolve beginner's guide (v1.4.x) and wiki.
  // Resource keys match the save's resource object keys.
  // ======================================================================
  var CHAINS = {
    Steel: {
      inputs: ['Iron', 'Coal'], via: 'Smelter (set to Steel)',
      note: 'Smelters consume Iron + Coal. Set fuel and the Steel/Titanium split via the smelter gear icon (Civics \u25B8 Industry).'
    },
    Titanium: {
      inputs: ['Iron', 'Coal'], via: 'Smelter (Hunter Process)',
      note: 'With Hunter Process learned, steel-producing Smelters also yield Titanium. Trade for the first 1,000 to unlock it.'
    },
    Alloy: {
      inputs: ['Copper', 'Titanium'], via: 'Factory (set to Alloy)',
      note: 'Factories turn Copper + Titanium into Alloy. Toggle the Factory output split in Civics \u25B8 Industry. Trading Alloy is often cheaper early.'
    },
    Polymer: {
      inputs: ['Oil', 'Lumber'], via: 'Factory (set to Polymer)',
      note: 'Factories make Polymer from Oil (+ Lumber unless an oil-only tech applies). Shares Factory capacity with Alloy \u2014 balance the split.'
    },
    Nano_Tube: {
      inputs: ['Coal', 'Titanium'], via: 'Factory (set to Nano-Tube)',
      note: 'Nano-Tubes are made in Factories from Coal + Titanium (needs the relevant tech first).'
    },
    Stanene: {
      inputs: ['Aluminium', 'Nano_Tube'], via: 'Factory (set to Stanene)',
      note: 'Stanene comes from Aluminium + Nano-Tubes in Factories (late-game tech).'
    },
    Plywood: {
      inputs: ['Lumber'], via: 'Craftsman (Plywood) at a Foundry',
      note: 'Foundry craftsmen craft Plywood from Lumber. Each craftsman makes ONE good \u2014 balance across Foundries. Manual bulk-craft also works.'
    },
    Brick: {
      inputs: ['Cement'], via: 'Craftsman (Brick) at a Foundry',
      note: 'Brick is crafted from Cement. Cement itself comes from Cement Plants consuming Stone.'
    },
    Wrought_Iron: {
      inputs: ['Iron'], via: 'Craftsman (Wrought Iron) at a Foundry',
      note: 'Crafted from Iron by Foundry craftsmen.'
    },
    Sheet_Metal: {
      inputs: ['Aluminium'], via: 'Craftsman (Sheet Metal) at a Foundry',
      note: 'Crafted from Aluminium. Needed for Wardenclyffes \u2014 craft plenty once Mad Science lands.'
    },
    Cement: {
      inputs: ['Stone'], via: 'Cement Plant + Cement Worker',
      note: 'Cement Workers in Cement Plants convert Stone \u2192 Cement. Powered plants produce more.'
    },
    Uranium: {
      inputs: ['Coal'], via: 'Coal Mine (Uranium extraction)',
      note: 'A small amount of Uranium is extracted alongside Coal once the tech is learned. Store it in adapted Fuel Depots.'
    }
  };

  function pretty(k) { return String(k).replace(/_/g, '-'); }

  // ======================================================================
  // SAVE LOADING (robust)
  // ======================================================================
  function getLZ() { return window.LZString || window.LZ || window.lzString || null; }

  function looksLikeSave(o) {
    if (!o || typeof o !== 'object') return false;
    if (o.resource && typeof o.resource === 'object') return true;
    var m = ['resource', 'tech', 'city', 'civic', 'race', 'evolution'], h = 0;
    for (var i = 0; i < m.length; i++) if (o[m[i]]) h++;
    return h >= 2;
  }

  function tryDecode(LZ, raw) {
    if (!raw || typeof raw !== 'string') return null;
    var c = [];
    try { c.push(LZ.decompressFromBase64(raw)); } catch (e) {}
    try { c.push(LZ.decompressFromEncodedURIComponent(raw)); } catch (e) {}
    try { c.push(LZ.decompressFromUTF16(raw)); } catch (e) {}
    try { c.push(LZ.decompress(raw)); } catch (e) {}
    c.push(raw);
    for (var i = 0; i < c.length; i++) {
      if (!c[i]) continue;
      try { var o = JSON.parse(c[i]); if (looksLikeSave(o)) return o; } catch (e) {}
    }
    return null;
  }

  var foundKey = null, lastKeys = [];
  function loadSave() {
    var LZ = getLZ();
    if (!LZ) { lastKeys = ['(LZString not loaded yet)']; return null; }
    if (foundKey) {
      var q = tryDecode(LZ, localStorage.getItem(foundKey));
      if (q) return q; foundKey = null;
    }
    var pref = ['evolved', 'evolve', 'save', 'evolveSave', 'gameSave'], tried = {};
    for (var i = 0; i < pref.length; i++) {
      tried[pref[i]] = 1;
      var s = tryDecode(LZ, localStorage.getItem(pref[i]));
      if (s) { foundKey = pref[i]; return s; }
    }
    lastKeys = [];
    for (var j = 0; j < localStorage.length; j++) {
      var key = localStorage.key(j);
      lastKeys.push(key);
      if (tried[key]) continue;
      var d = tryDecode(LZ, localStorage.getItem(key));
      if (d) { foundKey = key; return d; }
    }
    return null;
  }

  // ======================================================================
  // HELPERS
  // ======================================================================
  function num(n) {
    if (n == null || isNaN(n)) return '0';
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toString();
  }
  function res(save, k) { return save.resource ? save.resource[k] : null; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ======================================================================
  // ALERTS RULES
  // ======================================================================
  var SEV = { warn: 0, info: 1, good: 2 };

  function ruleKnowledge(save) {
    var kn = res(save, 'Knowledge');
    if (!kn || !kn.display || !(kn.max > 0)) return [];
    if (kn.amount / kn.max >= CAP_PCT && (kn.diff || 0) > 0) {
      return [{ sev: 'warn', title: 'Knowledge capped \u2014 research wasting',
        detail: 'At ' + num(kn.amount) + '/' + num(kn.max) + ', +' + num(kn.diff) +
          '/s overflowing. Buy a tech or raise the cap (Libraries / Wardenclyffe / Bioscience Labs).' }];
    }
    return [];
  }

  function ruleCapped(save) {
    var out = [], capped = [];
    var R = save.resource || {};
    for (var k in R) {
      var r = R[k];
      if (!r || !r.display || typeof r.amount !== 'number' || !(r.max > 0)) continue;
      if (k === 'Knowledge') continue;
      if (r.amount / r.max >= CAP_PCT && (r.diff || 0) >= MIN_WASTE_DIFF) {
        capped.push({ k: r.name || k, diff: r.diff });
      }
    }
    if (capped.length) {
      capped.sort(function (a, b) { return b.diff - a.diff; });
      out.push({ sev: 'warn',
        title: capped.length + ' resource' + (capped.length > 1 ? 's' : '') + ' capped',
        detail: capped.map(function (c) { return c.k + ' (+' + num(c.diff) + '/s)'; }).join(', ') +
          '. Add storage, spend it, or cut surplus producers.' });
    }
    return out;
  }

  function ruleDraining(save) {
    var out = [], drains = [];
    var R = save.resource || {};
    for (var k in R) {
      var r = R[k];
      if (!r || !r.display || typeof r.diff !== 'number') continue;
      if (r.diff < 0) {
        var secs = r.amount > 0 ? Math.round(r.amount / -r.diff) : 0;
        drains.push({ k: r.name || k, key: k, secs: secs, empty: r.amount <= 0 });
      }
    }
    if (drains.length) {
      drains.sort(function (a, b) { return a.secs - b.secs; });
      out.push({ sev: 'warn',
        title: drains.length + ' resource' + (drains.length > 1 ? 's' : '') + ' draining',
        detail: drains.map(function (d) {
          var base = d.empty ? d.k + ' (EMPTY)' : d.k + ' (~' + d.secs + 's)';
          var chain = CHAINS[d.key];
          if (chain) base += ' \u2192 needs ' + chain.inputs.map(pretty).join(' + ');
          return base;
        }).join('; ') + '. Add producers or cut consumption.' });
    }
    return out;
  }

  function ruleQueueGoals(save) {
    var out = [];
    var R = save.resource || {};
    function analyze(qobj, kind) {
      if (!qobj || !qobj.queue || !qobj.queue.length) return;
      qobj.queue.forEach(function (item) {
        var label = item.label || item.type || 'item';
        var t = item.time;
        var never = (t === null || t === undefined) ? false : (!isFinite(t) || t < 0 || t > 1e7);
        if (never) {
          var stalled = [];
          for (var k in R) {
            var r = R[k];
            if (!r || !r.display) continue;
            if ((r.diff || 0) <= 0 && r.amount < (r.max || Infinity) * 0.02) stalled.push(r.name || k);
          }
          out.push({ sev: 'warn', title: kind + ' stalled: ' + label,
            detail: '"' + label + '" shows Never \u2014 a required resource isn\u2019t accumulating.' +
              (stalled.length ? ' Likely blocked on: ' + stalled.slice(0, 4).join(', ') + '.' :
                ' Check its cost tooltip for the missing resource.') +
              ' Fix that input\u2019s production first.' });
        } else if (typeof t === 'number' && t > 3600) {
          out.push({ sev: 'info', title: kind + ' slow: ' + label,
            detail: '"' + label + '" is ~' + Math.round(t / 60) + ' min out. Boost its costliest input to speed it up.' });
        }
      });
    }
    analyze(save.queue, 'Build');
    analyze(save.r_queue, 'Research');
    return out;
  }

  function ruleLabor(save) {
    var out = [], civ = save.civic || {};
    var u = civ.unemployed;
    if (u && typeof u.workers === 'number' && u.workers > 0) {
      out.push({ sev: 'info', title: u.workers + ' unemployed',
        detail: 'Idle population. Assign to Professors/Scientists (research) or Miners (materials).' });
    }
    if (typeof civ.homeless === 'number' && civ.homeless > 0) {
      out.push({ sev: 'warn', title: civ.homeless + ' homeless',
        detail: 'Not enough housing \u2014 build houses/cottages/apartments.' });
    }
    return out;
  }

  function runAlerts(save) {
    var cards = [];
    [ruleKnowledge, ruleQueueGoals, ruleCapped, ruleDraining, ruleLabor].forEach(function (rule) {
      try { cards = cards.concat(rule(save) || []); } catch (e) {}
    });
    if (!cards.length) cards.push({ sev: 'good', title: 'Nothing urgent',
      detail: 'No capped storage, draining resources, or stalled queue items. Keep pushing your objective.' });
    cards.sort(function (a, b) { return SEV[a.sev] - SEV[b.sev]; });
    return cards;
  }

  // ======================================================================
  // CHAIN TAB
  // ======================================================================
  function buildChain(save) {
    var R = save.resource || {};
    var rows = [];
    for (var out in CHAINS) {
      var r = R[out];
      if (!r || !r.display) continue;
      var chain = CHAINS[out];
      var inputInfo = chain.inputs.map(function (inp) {
        var ir = R[inp];
        if (!ir) return { name: pretty(inp), known: false };
        var full = ir.max > 0 && ir.amount / ir.max >= CAP_PCT;
        var draining = (ir.diff || 0) < 0;
        var starved = ir.amount < (ir.max || Infinity) * 0.02 && (ir.diff || 0) <= 0;
        return { name: pretty(inp), known: true, diff: ir.diff || 0,
          state: draining || starved ? 'bad' : (full ? 'full' : 'ok') };
      });
      var outState = (r.diff || 0) < 0 ? 'bad' : (r.max > 0 && r.amount / r.max >= CAP_PCT ? 'full' : 'ok');
      rows.push({ out: pretty(out), via: chain.via, note: chain.note,
        inputs: inputInfo, outState: outState, outDiff: r.diff || 0 });
    }
    return rows;
  }

  // ======================================================================
  // UI
  // ======================================================================
  var STYLE = [
    ':root{--adv-lift:64px}',
    '#adv-panel{position:fixed;right:10px;bottom:calc(var(--adv-lift) + env(safe-area-inset-bottom,0px));',
      'z-index:99999;width:310px;max-width:calc(100vw - 20px);',
      'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e6edf3;',
      'background:rgba(16,20,24,.97);border:1px solid #2a333b;border-radius:10px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.55);backdrop-filter:blur(4px);overflow:hidden}',
    '#adv-panel.collapsed{width:auto}',
    '#adv-head{display:flex;align-items:center;gap:.5rem;padding:.55rem .7rem;cursor:pointer;',
      'background:linear-gradient(180deg,#141a1f,#0f1418);border-bottom:1px solid #2a333b;user-select:none}',
    '#adv-head .dot{width:8px;height:8px;border-radius:50%;background:#1abc9c;box-shadow:0 0 8px #1abc9c}',
    '#adv-head h3{margin:0;font-size:.86rem;font-weight:700;letter-spacing:.02em;flex:1}',
    '#adv-head .count{font-size:.72rem;color:#8fa1b3;background:#1f272e;border-radius:10px;padding:.05rem .45rem}',
    '#adv-head .chev{font-size:.7rem;color:#8fa1b3;transition:transform .15s}',
    '#adv-panel.collapsed .chev{transform:rotate(180deg)}',
    '#adv-panel.collapsed #adv-tabs,#adv-panel.collapsed #adv-body,#adv-panel.collapsed #adv-foot{display:none}',
    '#adv-tabs{display:flex;border-bottom:1px solid #2a333b;background:#10151a}',
    '.adv-tab{flex:1;text-align:center;font-size:.74rem;font-weight:600;padding:.45rem;cursor:pointer;',
      'color:#8fa1b3;border-bottom:2px solid transparent}',
    '.adv-tab.active{color:#63d6bd;border-bottom-color:#1abc9c}',
    '#adv-body{max-height:50vh;overflow-y:auto;padding:.5rem}',
    '.adv-card{border:1px solid #2a333b;border-left-width:3px;border-radius:7px;padding:.5rem .6rem;',
      'margin:.4rem 0;background:#191f25}',
    '.adv-card:first-child{margin-top:.1rem}',
    '.adv-card.warn{border-left-color:#e5534b}',
    '.adv-card.info{border-left-color:#f0a742}',
    '.adv-card.good{border-left-color:#1abc9c}',
    '.adv-card .t{font-size:.8rem;font-weight:600;margin:0 0 .2rem;line-height:1.25}',
    '.adv-card.warn .t{color:#ff8b84}.adv-card.info .t{color:#f6c073}.adv-card.good .t{color:#63d6bd}',
    '.adv-card .d{font-size:.73rem;color:#b7c3ce;line-height:1.4;margin:0}',
    '.adv-chain{border:1px solid #2a333b;border-radius:7px;padding:.5rem .6rem;margin:.4rem 0;background:#191f25}',
    '.adv-chain .co{font-size:.82rem;font-weight:700;margin:0 0 .15rem}',
    '.adv-chain .recipe{font-size:.75rem;margin:.15rem 0;display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}',
    '.adv-pill{font-size:.7rem;padding:.08rem .4rem;border-radius:10px;border:1px solid #2a333b;background:#12181d}',
    '.adv-pill.ok{color:#9fb4c4}.adv-pill.full{color:#f6c073;border-color:#5a4620}.adv-pill.bad{color:#ff8b84;border-color:#5a2420}',
    '.adv-arrow{color:#6b7885;font-size:.75rem}',
    '.adv-chain .via{font-size:.7rem;color:#8fa1b3;margin:.2rem 0 0}',
    '.adv-note{font-size:.7rem;color:#93a3b2;margin:.25rem 0 0;line-height:1.35;border-top:1px dashed #2a333b;padding-top:.25rem}',
    '#adv-foot{padding:.4rem .7rem;border-top:1px solid #2a333b;font-size:.66rem;color:#6b7885;',
      'display:flex;justify-content:space-between;align-items:center;gap:.4rem}',
    '#adv-foot .left{display:flex;align-items:center;gap:.5rem;flex:1;min-width:0}',
    '#adv-foot #adv-status{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#adv-foot button{background:#1f272e;color:#b7c3ce;border:1px solid #2a333b;border-radius:5px;',
      'font-size:.66rem;padding:.2rem .5rem;cursor:pointer}',
    '#adv-foot button:active{transform:translateY(1px)}',
    '#adv-wiki{display:flex;gap:.3rem;align-items:center;padding:.3rem .7rem;border-top:1px solid #2a333b;',
      'background:#10151a}',
    '#adv-wiki a{font-size:.68rem;color:#8fa1b3;text-decoration:none;padding:.15rem .45rem;',
      'border:1px solid #2a333b;border-radius:5px;background:#12181d}',
    '#adv-wiki a:hover{color:#63d6bd;border-color:#1abc9c}',
    '#adv-wiki .book{color:#6b7885;font-size:.68rem;margin-right:.1rem}',
    '#adv-panel.collapsed #adv-wiki{display:none}'
  ].join('');

  var activeTab = 'alerts';

  function injectStyle() {
    if (document.getElementById('adv-style')) return;
    var s = document.createElement('style'); s.id = 'adv-style'; s.textContent = STYLE;
    document.head.appendChild(s);
  }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function buildPanel() {
    var p = document.createElement('div'); p.id = 'adv-panel';
    p.innerHTML =
      '<div id="adv-head"><span class="dot"></span><h3>Advisor</h3>' +
        '<span class="count" id="adv-count">0</span><span class="chev">\u25BC</span></div>' +
      '<div id="adv-tabs">' +
        '<div class="adv-tab active" data-tab="alerts">Alerts</div>' +
        '<div class="adv-tab" data-tab="chain">Chain</div></div>' +
      '<div id="adv-body"></div>' +
      '<div id="adv-foot"><span class="left"><span id="adv-status">reading\u2026</span></span>' +
        '<button id="adv-refresh">Refresh</button></div>' +
      '<div id="adv-wiki"><span class="book">\uD83D\uDCD6</span>' +
        '<a href="' + WIKI_URL + '" target="_blank" rel="noopener">Wiki</a>' +
        '<a href="' + WIKI_URL + '#mechanics-basics" target="_blank" rel="noopener">Mechanics</a>' +
        '<a href="' + WIKI_URL + '#resources-market" target="_blank" rel="noopener">Resources</a>' +
        '<a href="' + WIKI_URL + '#resets-mad" target="_blank" rel="noopener">Resets</a>' +
      '</div>';
    document.body.appendChild(p);

    p.querySelector('#adv-head').addEventListener('click', function () {
      p.classList.toggle('collapsed');
      safeSet('adv-collapsed', p.classList.contains('collapsed') ? '1' : '0');
    });
    if (safeGet('adv-collapsed') === '1') p.classList.add('collapsed');

    Array.prototype.forEach.call(p.querySelectorAll('.adv-tab'), function (tab) {
      tab.addEventListener('click', function (e) {
        e.stopPropagation();
        activeTab = tab.getAttribute('data-tab');
        Array.prototype.forEach.call(p.querySelectorAll('.adv-tab'), function (t) {
          t.classList.toggle('active', t === tab);
        });
        render();
      });
    });
    p.querySelector('#adv-refresh').addEventListener('click', function (e) { e.stopPropagation(); render(); });
    return p;
  }

  function renderAlerts(save, body, countEl) {
    var cards = runAlerts(save);
    var actionable = cards.filter(function (c) { return c.sev !== 'good'; }).length;
    countEl.textContent = actionable;
    countEl.style.background = actionable ? '#3a1f1f' : '#1f272e';
    countEl.style.color = actionable ? '#ff8b84' : '#8fa1b3';
    body.innerHTML = cards.map(function (c) {
      return '<div class="adv-card ' + c.sev + '"><p class="t">' + esc(c.title) +
        '</p><p class="d">' + esc(c.detail) + '</p></div>';
    }).join('');
  }

  function renderChain(save, body, countEl) {
    var rows = buildChain(save);
    countEl.textContent = rows.length;
    countEl.style.background = '#1f272e'; countEl.style.color = '#8fa1b3';
    if (!rows.length) {
      body.innerHTML = '<div class="adv-card info"><p class="t">No derived resources yet</p>' +
        '<p class="d">Once you unlock Steel, Alloy, Polymer and friends, their recipes and live bottlenecks show here.</p></div>';
      return;
    }
    body.innerHTML = rows.map(function (row) {
      var pills = row.inputs.map(function (inp) {
        if (!inp.known) return '<span class="adv-pill">' + esc(inp.name) + '</span>';
        var rate = (inp.diff >= 0 ? '+' : '') + num(inp.diff) + '/s';
        return '<span class="adv-pill ' + inp.state + '">' + esc(inp.name) + ' ' + rate + '</span>';
      }).join('<span class="adv-arrow">+</span>');
      var outRate = (row.outDiff >= 0 ? '+' : '') + num(row.outDiff) + '/s';
      var outPill = '<span class="adv-pill ' + row.outState + '">' + esc(row.out) + ' ' + outRate + '</span>';
      return '<div class="adv-chain">' +
        '<p class="co">' + esc(row.out) + '</p>' +
        '<div class="recipe">' + pills + '<span class="adv-arrow">\u2192</span>' + outPill + '</div>' +
        '<p class="via">via ' + esc(row.via) + '</p>' +
        '<p class="adv-note">' + esc(row.note) + '</p>' +
        '</div>';
    }).join('');
  }

  function render() {
    var body = document.getElementById('adv-body');
    var countEl = document.getElementById('adv-count');
    var statusEl = document.getElementById('adv-status');
    if (!body) return;

    var save = loadSave();
    if (!save) {
      var keyList = lastKeys.length ? lastKeys.join(', ') : '(none)';
      var lzMsg = getLZ() ? '' : ' LZString isn\u2019t loaded \u2014 ensure advisor.js loads AFTER the game scripts.';
      body.innerHTML = '<div class="adv-card warn"><p class="t">No save found yet</p>' +
        '<p class="d">Couldn\u2019t decode a save.' + lzMsg + ' Play a few seconds, then Refresh.</p></div>' +
        '<div class="adv-card info"><p class="t">Storage keys seen</p><p class="d">' + esc(keyList) + '</p></div>';
      countEl.textContent = '!';
      if (statusEl) statusEl.textContent = 'no save';
      return;
    }

    if (activeTab === 'chain') renderChain(save, body, countEl);
    else renderAlerts(save, body, countEl);

    if (statusEl) {
      var ver = save.version ? 'v' + save.version : '';
      var race = save.race && save.race.species ? ' \u00b7 ' + save.race.species : '';
      statusEl.textContent = 'updated ' + new Date().toLocaleTimeString() + (ver ? ' \u00b7 ' + ver : '') + race;
    }
  }

  function boot() {
    if (document.getElementById('adv-panel')) return;
    injectStyle(); buildPanel(); render(); setInterval(render, REFRESH_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
