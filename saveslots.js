/*
 * saveslots.js — local save-slot manager for the Evolve fork.
 *
 * Adds up to 5 named save slots, stored in localStorage on THIS device.
 * Injected into the Settings tab, directly under the game's Import/Export block.
 *
 * Behaviour (per user choice):
 *   - Load overwrites the current game immediately (no auto-backup).
 *   - Slots auto-labelled with the date + time they were saved.
 *   - Lives in Settings, under the existing import/export controls.
 *
 * Self-contained: no game-bundle changes. The main save lives in
 * localStorage['evolved'] (LZString UTF16). Slots copy that exact string, so a
 * load is just: write the slot's string back to 'evolved' and reload the page.
 */
(function () {
  'use strict';

  var MAX_SLOTS = 5;
  var SLOT_KEY = 'evolve_saveslots_v1';   // our slots index+data live here
  var GAME_KEY = 'evolved';               // the game's own save key
  var TOKEN_KEY = 'evolve_gist_token';    // GitHub PAT (gist scope), local only
  var GISTID_KEY = 'evolve_gist_id';      // the gist we sync to (auto-set)
  var GIST_FILE = 'evolve_saveslots.json';

  // ---- storage helpers -------------------------------------------------
  function readSlots() {
    try {
      var raw = localStorage.getItem(SLOT_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeSlots(slots) {
    try { localStorage.setItem(SLOT_KEY, JSON.stringify(slots)); return true; }
    catch (e) { return false; }   // e.g. quota exceeded
  }
  function currentSave() {
    try { return localStorage.getItem(GAME_KEY) || null; } catch (e) { return null; }
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function bytes(str) {
    // rough size for display
    var n = str ? str.length : 0;
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ---- actions ---------------------------------------------------------
  function saveToSlot(index) {
    var save = currentSave();
    if (!save) { flash('No current game to save.', true); return; }
    var slots = readSlots();
    slots[index] = { label: stamp(), data: save, size: save.length };
    if (writeSlots(slots)) { flash('Saved to slot ' + (index + 1) + '.'); render(); }
    else { flash('Save failed (storage full?).', true); }
  }

  function newSlot() {
    var slots = readSlots();
    if (slots.length >= MAX_SLOTS) { flash('All ' + MAX_SLOTS + ' slots used. Overwrite one.', true); return; }
    var save = currentSave();
    if (!save) { flash('No current game to save.', true); return; }
    slots.push({ label: stamp(), data: save, size: save.length });
    if (writeSlots(slots)) { flash('Saved to new slot.'); render(); }
    else { flash('Save failed (storage full?).', true); }
  }

  function loadSlot(index) {
    var slots = readSlots();
    var slot = slots[index];
    if (!slot || !slot.data) { flash('Slot is empty.', true); return; }
    // Confirm — this overwrites the current game with no backup (user's choice).
    if (!window.confirm('Load slot ' + (index + 1) + ' (' + slot.label + ')?\n\nThis OVERWRITES your current game. There is no auto-backup.')) return;
    try {
      localStorage.setItem(GAME_KEY, slot.data);
      flash('Loaded. Reloading…');
      setTimeout(function () { window.location.reload(); }, 400);
    } catch (e) { flash('Load failed.', true); }
  }

  function deleteSlot(index) {
    var slots = readSlots();
    if (!slots[index]) return;
    if (!window.confirm('Delete slot ' + (index + 1) + ' (' + slots[index].label + ')?')) return;
    slots.splice(index, 1);
    writeSlots(slots);
    flash('Slot deleted.');
    render();
  }

  // ---- cloud sync (GitHub Gist) ---------------------------------------
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function getGistId() { try { return localStorage.getItem(GISTID_KEY) || ''; } catch (e) { return ''; } }
  function setGistId(id) { try { localStorage.setItem(GISTID_KEY, id); } catch (e) {} }

  function cloudUpload() {
    var token = getToken();
    if (!token) { flash('Enter your GitHub token first.', true); return; }
    var slots = readSlots();
    if (!slots.length) { flash('No slots to upload.', true); return; }

    var payload = JSON.stringify({ version: 1, savedAt: stamp(), slots: slots });
    var files = {}; files[GIST_FILE] = { content: payload };
    var gistId = getGistId();
    var setBusy = cloudBusy;

    setBusy(true, 'Uploading…');
    var url = 'https://api.github.com/gists' + (gistId ? '/' + gistId : '');
    fetch(url, {
      method: gistId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: 'Evolve save slots (synced)',
        public: false,
        files: files
      })
    }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status + (r.status === 401 ? ' (bad token?)' : '')); }
      return r.json();
    }).then(function (data) {
      if (data && data.id) { setGistId(data.id); }
      setBusy(false);
      flash('Uploaded ' + slots.length + ' slot' + (slots.length > 1 ? 's' : '') + ' to cloud.');
      render();
    }).catch(function (err) {
      setBusy(false);
      flash('Upload failed: ' + err.message, true);
    });
  }

  function cloudDownload() {
    var token = getToken();
    var gistId = getGistId();
    if (!token) { flash('Enter your GitHub token first.', true); return; }
    if (!gistId) { flash('No cloud save yet — upload once first, or paste a Gist ID.', true); return; }
    if (!window.confirm('Download cloud slots?\n\nThis REPLACES your local slots with the cloud copy.')) return;

    cloudBusy(true, 'Downloading…');
    fetch('https://api.github.com/gists/' + gistId, {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }).then(function (data) {
      var f = data && data.files && data.files[GIST_FILE];
      if (!f || !f.content) { throw new Error('no save file in gist'); }
      var parsed = JSON.parse(f.content);
      if (!parsed || !Array.isArray(parsed.slots)) { throw new Error('bad cloud data'); }
      writeSlots(parsed.slots.slice(0, MAX_SLOTS));
      cloudBusy(false);
      flash('Downloaded ' + parsed.slots.length + ' slot' + (parsed.slots.length > 1 ? 's' : '') + ' from cloud.');
      render();
    }).catch(function (err) {
      cloudBusy(false);
      flash('Download failed: ' + err.message, true);
    });
  }

  function cloudBusy(on, msg) {
    var u = document.getElementById('ess-up'), d = document.getElementById('ess-down');
    if (u) u.disabled = on; if (d) d.disabled = on;
    if (on && msg) flash(msg);
  }

  // ---- UI --------------------------------------------------------------
  var WRAP_ID = 'evolve-saveslots';

  function flash(msg, isErr) {
    var el = document.getElementById('ess-flash');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? '#e0704a' : '#4ac07a';
    el.style.opacity = '1';
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { el.style.opacity = '0'; }, 2500);
  }

  function css() {
    if (document.getElementById('ess-css')) return;
    var s = document.createElement('style');
    s.id = 'ess-css';
    s.textContent = [
      '#' + WRAP_ID + '{margin:1rem 0;padding:.75rem;border:2px solid var(--px-panel-hi,#585c46);border-radius:4px;background:rgba(0,0,0,.15)}',
      '#' + WRAP_ID + ' h3{margin:0 0 .5rem;font-size:1rem;color:var(--px-gold,#e8c14a)}',
      '#' + WRAP_ID + ' .ess-sub{font-size:.72rem;opacity:.7;margin-bottom:.6rem}',
      '#' + WRAP_ID + ' .ess-row{display:flex;align-items:center;gap:.4rem;padding:.3rem 0;border-top:1px solid rgba(255,255,255,.08)}',
      '#' + WRAP_ID + ' .ess-name{flex:1;min-width:0;font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#' + WRAP_ID + ' .ess-empty{flex:1;font-size:.8rem;opacity:.45;font-style:italic}',
      '#' + WRAP_ID + ' button{cursor:pointer;font:inherit;font-size:.72rem;padding:.25rem .5rem;border:1px solid var(--px-panel-hi,#585c46);border-radius:3px;background:var(--px-slot,#26281e);color:inherit}',
      '#' + WRAP_ID + ' button:active{transform:translateY(1px)}',
      '#' + WRAP_ID + ' .ess-load{color:#7ac0e8}',
      '#' + WRAP_ID + ' .ess-save{color:#e8c14a}',
      '#' + WRAP_ID + ' .ess-del{color:#e0704a;padding:.25rem .45rem}',
      '#' + WRAP_ID + ' .ess-new{margin-top:.5rem;width:100%;padding:.4rem;color:#4ac07a}',
      '#ess-flash{font-size:.75rem;min-height:1rem;transition:opacity .3s;opacity:0;margin-top:.4rem}',
      '#' + WRAP_ID + ' .ess-cloud{margin-top:.7rem;padding-top:.6rem;border-top:1px solid rgba(255,255,255,.12)}',
      '#' + WRAP_ID + ' .ess-csub{font-size:.72rem;opacity:.7;margin-bottom:.4rem}',
      '#' + WRAP_ID + ' .ess-cloud input{width:100%;box-sizing:border-box;margin-bottom:.35rem;padding:.35rem;font:inherit;font-size:.75rem;border:1px solid var(--px-panel-hi,#585c46);border-radius:3px;background:var(--px-slot-deep,#1b1d14);color:inherit}',
      '#' + WRAP_ID + ' .ess-cbtns{display:flex;gap:.4rem}',
      '#' + WRAP_ID + ' .ess-cbtns button{flex:1;padding:.4rem}',
      '#' + WRAP_ID + ' button:disabled{opacity:.5;cursor:default}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function render() {
    var wrap = document.getElementById(WRAP_ID);
    if (!wrap) return;
    var slots = readSlots();
    var rows = '';
    for (var i = 0; i < MAX_SLOTS; i++) {
      var s = slots[i];
      if (s) {
        rows += '<div class="ess-row">' +
          '<span class="ess-name">Slot ' + (i + 1) + ' — ' + s.label + ' (' + bytes(s.data) + ')</span>' +
          '<button class="ess-load" data-load="' + i + '">Load</button>' +
          '<button class="ess-save" data-save="' + i + '">Overwrite</button>' +
          '<button class="ess-del" data-del="' + i + '">\u2715</button>' +
          '</div>';
      } else {
        rows += '<div class="ess-row">' +
          '<span class="ess-empty">Slot ' + (i + 1) + ' — empty</span>' +
          '<button class="ess-save" data-save="' + i + '">Save here</button>' +
          '</div>';
      }
    }
    wrap.querySelector('.ess-body').innerHTML = rows;
    // wire buttons
    wrap.querySelectorAll('[data-load]').forEach(function (b) {
      b.onclick = function () { loadSlot(+b.getAttribute('data-load')); };
    });
    wrap.querySelectorAll('[data-save]').forEach(function (b) {
      b.onclick = function () { saveToSlot(+b.getAttribute('data-save')); };
    });
    wrap.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () { deleteSlot(+b.getAttribute('data-del')); };
    });
    // keep gist-id field current (upload auto-fills it)
    var gidEl = wrap.querySelector('#ess-gistid');
    if (gidEl && document.activeElement !== gidEl) { gidEl.value = getGistId(); }
  }

  function build(anchor) {
    if (document.getElementById(WRAP_ID)) return;   // already injected
    css();
    var wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    wrap.innerHTML =
      '<h3>Save Slots</h3>' +
      '<div class="ess-sub">Up to ' + MAX_SLOTS + ' local snapshots on this device. Loading overwrites your current game with no backup.</div>' +
      '<div class="ess-body"></div>' +
      '<div class="ess-cloud">' +
        '<div class="ess-csub">Cloud sync (GitHub Gist) — carries all slots between devices.</div>' +
        '<input id="ess-token" type="password" placeholder="GitHub token (gist scope)" autocomplete="off" spellcheck="false">' +
        '<input id="ess-gistid" type="text" placeholder="Gist ID (auto after first upload)" autocomplete="off" spellcheck="false">' +
        '<div class="ess-cbtns">' +
          '<button id="ess-up" class="ess-save">\u2191 Upload to cloud</button>' +
          '<button id="ess-down" class="ess-load">\u2193 Download from cloud</button>' +
        '</div>' +
      '</div>' +
      '<div id="ess-flash"></div>';
    // insert right after the import/export anchor
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);

    // populate + wire cloud fields
    var tokEl = wrap.querySelector('#ess-token');
    var gidEl = wrap.querySelector('#ess-gistid');
    if (tokEl) { tokEl.value = getToken(); tokEl.addEventListener('change', function () { setToken(tokEl.value.trim()); flash('Token saved on this device.'); }); }
    if (gidEl) { gidEl.value = getGistId(); gidEl.addEventListener('change', function () { setGistId(gidEl.value.trim()); }); }
    var upB = wrap.querySelector('#ess-up'), dnB = wrap.querySelector('#ess-down');
    if (upB) upB.onclick = cloudUpload;
    if (dnB) dnB.onclick = cloudDownload;

    render();
  }

  // ---- find the Settings import/export block ---------------------------
  // We don't know its exact id (game bundle not fully known here), so detect
  // it by content: the Settings tab has buttons/labels for import & export.
  function findAnchor() {
    // Only look when the Settings tab is actually visible.
    var candidates = document.querySelectorAll('#settings, #settings2, .tab-item, .settings, [id*="etting"]');
    // Heuristic: find an element whose text mentions both export and import.
    var all = document.querySelectorAll('div, section, fieldset');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 20) continue;   // skip huge containers
      var t = (el.textContent || '').toLowerCase();
      if (t.indexOf('export') !== -1 && t.indexOf('import') !== -1 && t.length < 600) {
        return el;
      }
    }
    return null;
  }

  // Poll: the Settings tab renders on demand, so watch for it to appear.
  function watch() {
    var anchor = findAnchor();
    if (anchor && !document.getElementById(WRAP_ID)) {
      build(anchor);
    } else if (!anchor && document.getElementById(WRAP_ID)) {
      // Settings tab was navigated away and re-rendered without our block; drop
      // our stale node so we re-inject cleanly next time.
      var stale = document.getElementById(WRAP_ID);
      if (stale && !stale.offsetParent) { stale.remove(); }
    }
  }

  function start() {
    setInterval(watch, 1000);   // lightweight; only acts when Settings is open
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
