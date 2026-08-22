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
  // PROGRESSION TIPS  (community-grounded, save-aware)
  // Sourced from the Evolve beginner's guide (wooledge.org) and the
  // Fandom wiki "311 Rule": 3 MAD resets, then 1 Bioseed, then 1 Black
  // Hole, then MAD again for Plasmids as needed. Tips fire based on which
  // prestige currencies and structures the save shows.
  // ======================================================================
  function detectStage(save) {
    // Prestige currencies live in save.prestige[X].count.
    var p = save.prestige || {};
    var pc = function (k) { return (p[k] && p[k].count) || 0; };
    // Reset counters live in save.stats — the ground truth for the 311 rule.
    var st = save.stats || {};
    var plasmid = pc('Plasmid');
    var phage = pc('Phage');
    var dark = pc('Dark');
    return {
      plasmid: plasmid, phage: phage, dark: dark,
      harmony: pc('Harmony'), artifact: pc('Artifact'),
      madCount: st.mad || 0,
      bioseedCount: st.bioseed || 0,
      blackholeCount: st.blackhole || 0,
      totalResets: st.reset || 0,
      ascendCount: st.ascend || 0,
      hasMAD: plasmid > 0 || (st.mad || 0) > 0
    };
  }

  function progressionTips(save) {
    var tips = [];
    var s = detectStage(save);

    // Where are you in the 311 rule? Use real reset counters.
    var stageLine = 'Resets so far \u2014 MAD: ' + s.madCount + ', Bioseed: ' +
      s.bioseedCount + ', Black Hole: ' + s.blackholeCount +
      '. Plasmids: ' + s.plasmid + (s.phage ? ', Phage: ' + s.phage : '') + '.';
    tips.push({ sev: 'good', title: 'Your progress (311 rule)', detail: stageLine });

    // Decide the next recommended milestone from the counters.
    if (s.blackholeCount > 0) {
      tips.push({ sev: 'info', title: 'Endgame \u2014 your call now',
        detail: 'You\u2019ve done a Black Hole reset, so the beginner 311 path is complete. From here it\u2019s Whitehole/Vacuum, Ascension, or challenge universes \u2014 pick based on the achievements/perks you\u2019re chasing.' });
    } else if (s.bioseedCount > 0) {
      tips.push({ sev: 'info', title: 'Next: Black Hole reset',
        detail: 'You\u2019ve Bioseeded (' + s.bioseedCount + '\u00d7). Push interstellar: research Stellar Engine, build all 100 segments, add a Mass Ejector, and feed it mass until the Black Hole reset unlocks. First one can take real-life days \u2014 that\u2019s normal.' });
    } else if (s.madCount >= 3) {
      tips.push({ sev: 'info', title: 'Next: go for Bioseed',
        detail: 'You\u2019ve done ' + s.madCount + ' MAD resets \u2014 the 311 rule says it\u2019s time for your first Bioseed. Research toward the Genesis Ship (needs Supercollider/ARPA techs), build the Space Dock + Bioseeder (100 segments), and add as many Probes as possible \u2014 each Probe = one more planet choice next run.' });
    } else if (s.madCount > 0) {
      tips.push({ sev: 'info', title: 'Keep MAD-resetting (' + s.madCount + '/3)',
        detail: 'The 311 rule suggests ~3 MAD resets before Bioseed. Each is quick and stacks Plasmids that boost all production. Do ' + (3 - s.madCount) + ' more, teching a bit further each run, before the long Bioseed build.' });
    } else if (s.plasmid > 0) {
      tips.push({ sev: 'info', title: 'MAD is unlocked \u2014 use it',
        detail: 'You have Plasmids but the counter shows no MAD reset yet. Once you\u2019ve teched comfortably past your last wall, pull the MAD trigger \u2014 Plasmids permanently speed every future run.' });
    } else {
      tips.push({ sev: 'info', title: 'First goal: unlock MAD',
        detail: 'Research toward Mutual Assured Destruction. Your first MAD reset grants Plasmids, which permanently speed every future run. Don\u2019t over-invest before that first reset.' });
    }

    // Universal payout tip.
    tips.push({ sev: 'info', title: 'Maximize each reset\u2019s payout',
      detail: 'Prestige currency scales with population AND total Knowledge spent on research \u2014 Knowledge weighs more. Before any reset, buy every affordable tech so your spent-Knowledge is as high as possible.' });

    // Plasmid spending / CRISPR guidance, driven by the live Plasmid count.
    // Community rule: hold ~250 Plasmids for the production bonus (diminishing
    // returns past that); spend only the surplus above 250 in CRISPR on
    // permanent traits. CRISPR unlocks after Genome Sequencing (ARPA+Genetics).
    var PLASMID_HOLD = 250;
    if (s.plasmid > 0) {
      if (s.plasmid < PLASMID_HOLD) {
        tips.push({ sev: 'info', title: 'Don\u2019t spend Plasmids yet (' + s.plasmid + '/' + PLASMID_HOLD + ')',
          detail: 'Every Plasmid is currently boosting all production. The community rule is to hold ~' + PLASMID_HOLD +
            ' before spending any in CRISPR. Keep MAD-resetting to grow the stockpile \u2014 don\u2019t dip below the bonus.' });
      } else {
        var surplus = s.plasmid - PLASMID_HOLD;
        tips.push({ sev: 'good', title: 'Surplus Plasmids ready to spend (' + surplus + ' over ' + PLASMID_HOLD + ')',
          detail: 'You\u2019re past the ~' + PLASMID_HOLD + ' hold point, where the production bonus hits diminishing returns. Spend the surplus in CRISPR (ARPA tab) on PERMANENT traits that carry across all resets. Favor cost-reductions and prestige-gain boosts that speed the START of every future run over one-off conveniences. Keep ~' + PLASMID_HOLD + ' banked for the bonus.' });
      }
    }

    // Live nudge from current save.
    var kn = save.resource && save.resource.Knowledge;
    if (kn && kn.max > 0 && kn.amount / kn.max >= CAP_PCT) {
      tips.push({ sev: 'warn', title: 'Raise your Knowledge cap',
        detail: 'Knowledge is capped right now, throttling how fast you tech toward the next reset. Build Libraries / Wardenclyffe / Bioscience Labs \u2014 higher cap = faster progression and a bigger reset payout.' });
    }

    return tips;
  }

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
    '#adv-panel.collapsed #adv-wiki{display:none}',
    // wiki overlay
    '#adv-wiki-overlay{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;',
      'background:#0f1418}',
    '#adv-wiki-bar{display:flex;align-items:center;justify-content:space-between;',
      'padding:.5rem .8rem;background:#141a1f;border-bottom:1px solid #2a333b;color:#e6edf3;',
      'font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:.9rem;font-weight:700;',
      'padding-top:calc(.5rem + env(safe-area-inset-top,0px))}',
    '#adv-wiki-close{background:#1f272e;color:#e6edf3;border:1px solid #2a333b;border-radius:6px;',
      'font-size:.85rem;padding:.35rem .8rem;cursor:pointer;font-weight:700}',
    '#adv-wiki-close:active{transform:translateY(1px)}',
    '#adv-wiki-frame{flex:1;width:100%;border:0;background:#fff}',
    // The wiki is a desktop-width page; render it wider then scale to fit so it
    // isn\u2019t cut off. 1.4x width @ ~71% scale ≈ fits a phone without h-scroll.
    '#adv-wiki-frame.scaled{width:143%;height:143%;transform:scale(.7);transform-origin:top left}'
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
        '<div class="adv-tab" data-tab="chain">Chain</div>' +
        '<div class="adv-tab" data-tab="guide">Guide</div></div>' +
      '<div id="adv-body"></div>' +
      '<div id="adv-foot"><span class="left"><span id="adv-status">reading\u2026</span></span>' +
        '<button id="adv-refresh">Refresh</button></div>' +
      '<div id="adv-wiki"><span class="book">\uD83D\uDCD6</span>' +
        '<a data-hash="">Wiki</a>' +
        '<a data-hash="#mechanics-basics">Mechanics</a>' +
        '<a data-hash="#resources-market">Resources</a>' +
        '<a data-hash="#resets-mad">Resets</a>' +
      '</div>';
    document.body.appendChild(p);

    // Wiki opens in an in-app overlay (iframe) with a close button, so the
    // PWA never navigates away and you return exactly where you were.
    Array.prototype.forEach.call(p.querySelectorAll('#adv-wiki a'), function (a) {
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        openWiki(a.getAttribute('data-hash') || '');
      });
    });

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

  function renderGuide(save, body, countEl) {
    var tips = progressionTips(save);
    var actionable = tips.filter(function (t) { return t.sev === 'warn'; }).length;
    countEl.textContent = actionable || tips.length;
    countEl.style.background = actionable ? '#3a1f1f' : '#1f272e';
    countEl.style.color = actionable ? '#ff8b84' : '#8fa1b3';
    body.innerHTML = tips.map(function (c) {
      return '<div class="adv-card ' + c.sev + '"><p class="t">' + esc(c.title) +
        '</p><p class="d">' + esc(c.detail) + '</p></div>';
    }).join('') +
    '<div class="adv-card info"><p class="t">More detail</p><p class="d">' +
      'Tap a wiki link below for the full mechanics. These tips are grounded in the community beginner\u2019s guide, adapted to your current save stage.</p></div>';
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
    else if (activeTab === 'guide') renderGuide(save, body, countEl);
    else renderAlerts(save, body, countEl);

    if (statusEl) {
      var ver = save.version ? 'v' + save.version : '';
      var race = save.race && save.race.species ? ' \u00b7 ' + save.race.species : '';
      statusEl.textContent = 'updated ' + new Date().toLocaleTimeString() + (ver ? ' \u00b7 ' + ver : '') + race;
    }
  }

  // In-app wiki overlay: loads wiki.html in an iframe layer over the game.
  function openWiki(hash) {
    var existing = document.getElementById('adv-wiki-overlay');
    if (existing) existing.parentNode.removeChild(existing);
    var ov = document.createElement('div');
    ov.id = 'adv-wiki-overlay';
    ov.innerHTML =
      '<div id="adv-wiki-bar">' +
        '<span id="adv-wiki-title">\uD83D\uDCD6 Evolve Wiki</span>' +
        '<button id="adv-wiki-close">\u2715 Close</button>' +
      '</div>' +
      '<iframe id="adv-wiki-frame" class="scaled" src="' + WIKI_URL + hash + '" ' +
        'referrerpolicy="no-referrer"></iframe>';
    document.body.appendChild(ov);
    document.getElementById('adv-wiki-close').addEventListener('click', closeWiki);
    // Android hardware back / gesture: intercept to close overlay first.
    try {
      history.pushState({ advWiki: 1 }, '');
      window.addEventListener('popstate', wikiPop);
    } catch (e) {}
  }
  function wikiPop() { closeWiki(); }
  function closeWiki() {
    var ov = document.getElementById('adv-wiki-overlay');
    if (ov) ov.parentNode.removeChild(ov);
    window.removeEventListener('popstate', wikiPop);
  }

  function boot() {
    if (document.getElementById('adv-panel')) return;
    injectStyle(); buildPanel(); render(); setInterval(render, REFRESH_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
