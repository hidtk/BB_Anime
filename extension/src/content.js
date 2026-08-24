/*
 * content.js — поиск <video>, оверлей субтитров в Shadow DOM, синхронизация.
 */
(function () {
  'use strict';
  if (window.__subOverlayInstalled) return;
  window.__subOverlayInstalled = true;

  var TAG = 'sub-overlay-' + Math.random().toString(36).slice(2, 8);
  var SHIFT_KEY = 'subOverlay:shift:' + location.host;
  var DEFAULTS = {
    fontSizePct: 4.5,      // % от высоты видео
    bottomPct: 10,         // % от высоты видео
    bgOpacity: 0.45,
    color: '#ffffff',
    outline: true,
    rememberPerSite: true
  };

  var state = {
    cues: [],
    fileName: '',
    format: '',
    encoding: '',
    fromMemory: false,
    shift: readShift(),
    settings: Object.assign({}, DEFAULTS),
    video: null,
    videos: [],
    lastHtml: null,
    pendingRestore: null,
    rafId: 0,
    lastRect: null,
    hidden: false
  };

  var host = null, shadow = null, box = null, textEl = null, toastEl = null, dropEl = null;
  var videoIds = new WeakMap();
  var videoSeq = 0;

  // ---------------- настройки ----------------

  try {
    chrome.storage.sync.get(DEFAULTS, function (s) {
      if (chrome.runtime.lastError) return;
      state.settings = Object.assign({}, DEFAULTS, s || {});
      state.lastRect = null;
      applyStyles();
      maybeRestore();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      var touched = false;
      Object.keys(changes).forEach(function (k) {
        if (k in DEFAULTS) { state.settings[k] = changes[k].newValue; touched = true; }
      });
      if (touched) { state.lastRect = null; applyStyles(); }
    });
  } catch (e) { /* расширение перезагружено — не мешаем странице */ }

  function readShift() {
    try {
      var v = parseFloat(sessionStorage.getItem(SHIFT_KEY));
      return isFinite(v) ? v : 0;
    } catch (e) { return 0; }
  }
  function writeShift() {
    try { sessionStorage.setItem(SHIFT_KEY, String(state.shift)); } catch (e) {}
  }

  // ---------------- поиск видео ----------------

  var lastShadowScan = 0;
  var everHadVideo = false;

  // Пока плеера на странице нет — ищем часто (он может появиться в любой момент).
  // Как только видео хоть раз нашлось, обход Shadow DOM можно сильно разредить.
  function shadowScanInterval() {
    return everHadVideo ? 3000 : 600;
  }

  function collectVideos() {
    var found = [];
    var seen = new Set();
    function add(v) { if (!seen.has(v)) { seen.add(v); found.push(v); } }
    try {
      document.querySelectorAll('video').forEach(add);
    } catch (e) {}
    // Обход Shadow DOM дорогой (querySelectorAll('*') по всему документу),
    // поэтому только если обычным способом видео не нашлось, и не чаще
    // раза в полторы секунды — иначе на «живых» SPA это жжёт процессор.
    if (!found.length) {
      var now = nowMs();
      if (now - lastShadowScan >= shadowScanInterval()) {
        lastShadowScan = now;
        try { scanShadow(document.documentElement, 0, add); } catch (e) {}
      } else if (shadowCache.length) {
        shadowCache.forEach(function (v) { if (v.isConnected) add(v); });
      }
    }
    return found;
  }

  var shadowCache = [];

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function scanShadow(root, depth, add) {
    if (!root || depth > 4) return;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr) {
        sr.querySelectorAll('video').forEach(function (v) {
          if (shadowCache.indexOf(v) === -1) shadowCache.push(v);
          add(v);
        });
        scanShadow(sr, depth + 1, add);
      }
    }
    if (depth === 0) {
      shadowCache = shadowCache.filter(function (v) { return v.isConnected; });
    }
  }

  function videoId(v) {
    if (!videoIds.has(v)) videoIds.set(v, ++videoSeq);
    return videoIds.get(v);
  }

  function isUsable(v) {
    if (!v.isConnected) return false;
    var r = v.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  }

  function score(v) {
    var r = v.getBoundingClientRect();
    var s = r.width * r.height;
    if (!v.paused) s *= 4;
    if (v.currentTime > 0) s *= 2;
    if (v.readyState > 0) s *= 1.5;
    return s;
  }

  function refreshVideos(preferId) {
    var list = collectVideos();
    state.videos = list;
    var usable = list.filter(isUsable);
    var pool = usable.length ? usable : list;

    var chosen = null;
    if (preferId) chosen = pool.filter(function (v) { return videoId(v) === preferId; })[0] || null;
    if (!chosen && state.video && state.video.isConnected && pool.indexOf(state.video) !== -1) {
      chosen = state.video;
    }
    if (!chosen) {
      chosen = pool.slice().sort(function (a, b) { return score(b) - score(a); })[0] || null;
    }
    if (chosen !== state.video) attachTo(chosen);
    return state.videos;
  }

  var discoveryTimer = 0;

  // MutationObserver не видит изменения внутри shadow root, поэтому пока
  // плеер не найден, раз в секунду перепроверяем страницу. Как только видео
  // появилось — опрос останавливается и ничего не стоит.
  function ensureDiscoveryPoll() {
    if (state.video && state.video.isConnected) {
      if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = 0; }
      return;
    }
    if (discoveryTimer) return;
    discoveryTimer = setInterval(function () {
      if (document.hidden) return;
      refreshVideos();
      if (state.video) { clearInterval(discoveryTimer); discoveryTimer = 0; }
    }, 1000);
  }

  function attachTo(v) {
    detachEvents();
    state.video = v || null;
    state.lastHtml = null;
    state.lastRect = null;
    if (state.video) { attachEvents(); everHadVideo = true; }
    ensureDiscoveryPoll();
    render(true);
    if (state.video && state.pendingRestore && !state.cues.length) applyRestore(state.pendingRestore);
  }

  var evtHandler = function () { render(); };
  function attachEvents() {
    if (!state.video) return;
    ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ratechange', 'loadedmetadata', 'emptied'].forEach(function (e) {
      state.video.addEventListener(e, evtHandler);
    });
  }
  function detachEvents() {
    if (!state.video) return;
    ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ratechange', 'loadedmetadata', 'emptied'].forEach(function (e) {
      try { state.video.removeEventListener(e, evtHandler); } catch (err) {}
    });
  }

  // наблюдаем за DOM: плеер может появиться позже и пересоздаться при смене серии
  var rescanTimer = 0;
  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(function () {
      rescanTimer = 0;
      if (state.video && !state.video.isConnected) attachTo(null);
      refreshVideos();
    }, 300);
  }

  function touchesVideo(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || n.nodeType !== 1) continue;
      if (n.tagName === 'VIDEO') return true;
      try { if (n.querySelector && n.querySelector('video')) return true; } catch (e) {}
      if (n.shadowRoot) return true;
    }
    return false;
  }

  try {
    new MutationObserver(function (muts) {
      // На «живых» SPA мутации летят сотнями в секунду: пересканируем только
      // если видео пропало, ещё не найдено или в DOM появился новый плеер.
      var needScan = !state.video || !state.video.isConnected;
      if (!needScan) {
        for (var i = 0; i < muts.length; i++) {
          if (touchesVideo(muts[i].addedNodes) || touchesVideo(muts[i].removedNodes)) {
            needScan = true;
            break;
          }
        }
      }
      if (needScan) scheduleRescan();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // media-события не всплывают, но проходят фазу перехвата
  ['play', 'loadedmetadata', 'playing'].forEach(function (e) {
    document.addEventListener(e, function (ev) {
      if (ev.target && ev.target.tagName === 'VIDEO') scheduleRescan();
    }, true);
  });

  // ---------------- оверлей (Shadow DOM) ----------------

  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement(TAG);
    host.setAttribute('data-sub-overlay', '1');
    setHostStyle({ left: 0, top: 0, width: 0, height: 0 });
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '.wrap { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; pointer-events: none; overflow: hidden; }',
      '.text { max-width: 92%; text-align: center; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-weight: 600; line-height: 1.25; white-space: pre-wrap; word-wrap: break-word; padding: 0.12em 0.5em; border-radius: 0.18em; box-sizing: border-box; }',
      '.text:empty { display: none; }',
      '.text i { font-style: italic; }',
      '.text b { font-weight: 800; }',
      '.toast { position: absolute; left: 50%; transform: translateX(-50%); top: 6%; background: rgba(0,0,0,0.78); color: #fff; font: 600 14px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 7px 12px; border-radius: 6px; opacity: 0; transition: opacity .18s; white-space: nowrap; }',
      '.toast.show { opacity: 1; }',
      '.drop { position: absolute; inset: 0; border: 3px dashed rgba(255,255,255,0.9); background: rgba(0,0,0,0.55); color: #fff; font: 700 20px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; display: none; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; }',
      '.drop.show { display: flex; }'
    ].join('\n');

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    textEl = document.createElement('div');
    textEl.className = 'text';
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    dropEl = document.createElement('div');
    dropEl.className = 'drop';
    dropEl.textContent = 'Отпустите файл .srt / .ass — субтитры загрузятся';
    wrap.appendChild(textEl);
    box = wrap;
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    shadow.appendChild(toastEl);
    shadow.appendChild(dropEl);

    mountHost();
    applyStyles();
  }

  // Полноэкранный режим: браузер рисует только поддерево fullscreen-элемента.
  // Надёжнее всего вывести оверлей в top layer через Popover API (Chrome 114+),
  // потому что сайт может развернуть на весь экран сам <video> — внутрь него
  // ничего вставить нельзя. Запасной путь — перенос узла внутрь fullscreen-элемента.
  var popoverOn = false, lastFsEl = undefined, fsTick = 0;

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function supportsPopover() {
    return typeof HTMLElement !== 'undefined' &&
      typeof HTMLElement.prototype.showPopover === 'function';
  }

  function applyMount(fsEl, body) {
    if (!fsEl) {
      if (popoverOn) { try { host.hidePopover(); } catch (e) {} popoverOn = false; }
      if (host.parentNode !== body) { try { body.appendChild(host); } catch (e) {} }
      return;
    }
    if (supportsPopover()) {
      if (host.parentNode !== body) { try { body.appendChild(host); } catch (e) {} }
      if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
      try { host.hidePopover(); } catch (e) {}
      try { host.showPopover(); popoverOn = true; return; } catch (e) { popoverOn = false; }
    }
    var target = /^(VIDEO|AUDIO|IMG|CANVAS|IFRAME)$/.test(fsEl.tagName) ? (fsEl.parentElement || fsEl) : fsEl;
    if (host.parentNode !== target) { try { target.appendChild(host); } catch (e) {} }
  }

  function mountHost() {
    if (!host) return;
    var body = document.body || document.documentElement;
    var fsEl = fsElement();
    if (fsEl !== lastFsEl) {
      lastFsEl = fsEl;
      state.lastRect = null;
      applyMount(fsEl, body);
      return;
    }
    if (fsEl) {
      // раз в ~30 кадров проверяем, что нас не вытеснили из top layer
      if (popoverOn && (++fsTick % 30 === 0)) {
        try { if (!host.matches(':popover-open')) applyMount(fsEl, body); } catch (e) {}
      }
    } else if (host.parentNode !== body) {
      applyMount(null, body);
    }
  }

  function setHostStyle(rect) {
    var css = {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      'z-index': '2147483647',
      'pointer-events': 'none',
      display: 'block',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      contain: 'layout style',
      visibility: 'visible',
      opacity: '1',
      transform: 'none',
      'max-width': 'none',
      'max-height': 'none'
    };
    Object.keys(css).forEach(function (k) { host.style.setProperty(k, css[k], 'important'); });
  }

  function applyStyles() {
    if (!textEl || !state.video) return;
    var h = state.video.getBoundingClientRect().height || 0;
    var s = state.settings;
    var px = Math.max(12, Math.round(h * (s.fontSizePct / 100)));
    textEl.style.fontSize = px + 'px';
    textEl.style.color = s.color || '#fff';
    textEl.style.marginBottom = Math.round(h * (s.bottomPct / 100)) + 'px';
    textEl.style.background = s.bgOpacity > 0 ? 'rgba(0,0,0,' + s.bgOpacity + ')' : 'transparent';
    var o = Math.max(1, Math.round(px / 22));
    textEl.style.textShadow = s.outline
      ? ['-1px -1px', '1px -1px', '-1px 1px', '1px 1px', '0 2px'].map(function (p) {
          return p.split(' ').map(function (v) { return v === '0' ? '0' : (parseInt(v, 10) * o) + 'px'; }).join(' ') + ' 0 #000';
        }).join(', ') + ', 0 0 ' + (o * 4) + 'px rgba(0,0,0,0.9)'
      : 'none';
  }

  function removeOverlay() {
    stopLoop();
    if (host && popoverOn) { try { host.hidePopover(); } catch (e) {} }
    popoverOn = false;
    lastFsEl = undefined;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; shadow = null; textEl = null; toastEl = null; dropEl = null;
    state.lastHtml = null;
    state.lastRect = null;
  }

  // ---------------- цикл отрисовки ----------------

  function active() { return state.cues.length > 0 && state.video && state.video.isConnected; }

  function startLoop() {
    if (state.rafId) return;
    var frame = 0;
    var tick = function () {
      state.rafId = requestAnimationFrame(tick);
      // на паузе достаточно ~10 кадров в секунду — не жжём CPU
      if (state.video && state.video.paused && (++frame % 6)) return;
      render();
    };
    state.rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function render(force) {
    if (!active()) {
      if (host) { textEl && (textEl.innerHTML = ''); }
      stopLoop();
      return;
    }
    ensureOverlay();
    startLoop();
    mountHost();

    var v = state.video;
    var r = v.getBoundingClientRect();
    var lr = state.lastRect;
    if (force || !lr || Math.abs(lr.left - r.left) > 0.5 || Math.abs(lr.top - r.top) > 0.5 ||
        Math.abs(lr.width - r.width) > 0.5 || Math.abs(lr.height - r.height) > 0.5) {
      state.lastRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      setHostStyle(state.lastRect);
      applyStyles();
    }

    var visible = r.width > 20 && r.height > 20 && r.bottom > 0 && r.right > 0 &&
                  r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
    host.style.setProperty('opacity', visible ? '1' : '0', 'important');

    var t = v.currentTime - state.shift;
    var html = SubParse.activeHtml(state.cues, t);
    if (html !== state.lastHtml) {
      state.lastHtml = html;
      textEl.innerHTML = html;
    }
  }

  window.addEventListener('resize', function () { state.lastRect = null; render(true); }, true);
  window.addEventListener('scroll', function () { render(); }, true);
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (e) {
    document.addEventListener(e, function () {
      state.lastRect = null;
      if (host) mountHost();
      setTimeout(function () { state.lastRect = null; render(true); }, 60);
      setTimeout(function () { state.lastRect = null; render(true); }, 400);
    }, true);
  });
  // Подстраховка: если поверх фуллскрина открыт popover, Escape всё равно
  // должен выводить из полноэкранного режима.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!popoverOn || !fsElement()) return;
    try { host.hidePopover(); } catch (err) {}
    popoverOn = false;
    if (document.exitFullscreen) {
      var p = document.exitFullscreen();
      if (p && p.catch) p.catch(function () {});
    }
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop(); else render(true);
  });

  // ---------------- загрузка субтитров ----------------

  function loadFromText(text, name, encoding) {
    var res = SubParse.parse(text, name);
    if (!res.cues.length) {
      toast('Не удалось разобрать файл: ' + (name || ''));
      return { ok: false, error: 'Файл не распознан как SRT или ASS' };
    }
    state.cues = res.cues;
    state.fileName = name || '';
    state.format = res.format;
    state.encoding = encoding || '';
    state.fromMemory = false;
    state.lastHtml = null;
    refreshVideos();
    render(true);
    toast('Субтитры: ' + state.fileName + ' — ' + res.cues.length + ' реплик' + (encoding ? ' (' + encoding + ')' : ''));
    remember();
    return { ok: true, count: res.cues.length, format: res.format };
  }

  function loadFromFile(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        var dec = SubParse.decodeBytes(fr.result);
        resolve(loadFromText(dec.text, file.name, dec.encoding));
      };
      fr.onerror = function () { resolve({ ok: false, error: 'Не удалось прочитать файл' }); };
      fr.readAsArrayBuffer(file);
    });
  }

  function clearSubs() {
    state.cues = [];
    state.pendingRestore = null;
    state.fileName = '';
    state.format = '';
    state.fromMemory = false;
    state.lastHtml = null;
    if (textEl) textEl.innerHTML = '';
    removeOverlay();
    forget();
  }

  // память по домену (P1)
  function memKey() { return 'subs:' + location.host; }
  function remember() {
    if (!state.settings.rememberPerSite) return;
    try {
      var payload = { name: state.fileName, format: state.format, cues: state.cues, ts: Date.now() };
      var json = JSON.stringify(payload);
      if (json.length > 3000000) return;
      var obj = {}; obj[memKey()] = payload;
      chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }
  function forget() {
    try { chrome.storage.local.remove(memKey(), function () { void chrome.runtime.lastError; }); } catch (e) {}
  }
  function applyRestore(data) {
    if (!data || state.cues.length || !state.video) return;
    state.pendingRestore = null;
    state.cues = data.cues;
    state.fileName = data.name || '';
    state.format = data.format || '';
    state.fromMemory = true;
    render(true);
    toast('Восстановлены субтитры: ' + state.fileName);
  }

  function maybeRestore() {
    if (!state.settings.rememberPerSite || state.cues.length) return;
    try {
      chrome.storage.local.get(memKey(), function (res) {
        if (chrome.runtime.lastError) return;
        var data = res && res[memKey()];
        if (!data || !data.cues || !data.cues.length || state.cues.length) return;
        refreshVideos();
        if (!state.video) { state.pendingRestore = data; return; }
        applyRestore(data);
      });
    } catch (e) {}
  }

  // ---------------- сдвиг и горячие клавиши ----------------

  function setShift(v) {
    state.shift = Math.round(v * 100) / 100;
    writeShift();
    state.lastHtml = null;
    render(true);
    return state.shift;
  }
  function bumpShift(d) {
    setShift(state.shift + d);
    toast('Сдвиг: ' + (state.shift > 0 ? '+' : '') + state.shift.toFixed(2) + ' с' +
      (state.shift === 0 ? '' : state.shift > 0 ? ' (позже)' : ' (раньше)'));
  }

  function typingTarget(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  var HOTKEY_MSG = 'sub-overlay-hotkey-v1';

  function applyHotkey(action) {
    if (!state.cues.length) return false;
    if (action === 'reset') { setShift(0); toast('Сдвиг сброшен'); return true; }
    var map = { back: -0.5, fwd: 0.5, bigback: -5, bigfwd: 5 };
    if (!(action in map)) return false;
    bumpShift(map[action]);
    return true;
  }

  // Плеер может жить во фрейме: если субтитры не здесь — передаём нажатие дальше.
  function broadcastHotkey(action) {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage({ __subOverlay: HOTKEY_MSG, action: action }, '*'); } catch (e) {}
    }
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__subOverlay !== HOTKEY_MSG || !d.action) return;
    if (!isParentWindow(e.source)) return; // только «сверху вниз»
    if (!applyHotkey(d.action)) broadcastHotkey(d.action);
  });

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (typingTarget(e.target) || typingTarget(document.activeElement)) return;
    var action = null;
    if (e.code === 'KeyG') action = e.shiftKey ? 'bigback' : 'back';
    else if (e.code === 'KeyH') action = e.shiftKey ? 'bigfwd' : 'fwd';
    else if (e.code === 'KeyJ' && !e.shiftKey) action = 'reset';
    if (!action) return;
    if (applyHotkey(action)) { e.preventDefault(); e.stopPropagation(); }
    else broadcastHotkey(action);
  }, true);

  function toast(msg) {
    if (!state.video) return;
    ensureOverlay();
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl && toastEl.classList.remove('show'); }, 1800);
  }

  // ---------------- drag & drop ----------------

  function hasSubFile(dt) {
    if (!dt) return false;
    var types = dt.types ? Array.prototype.slice.call(dt.types) : [];
    if (types.indexOf('Files') === -1) return false;
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind !== 'file') continue;
        var f = it.getAsFile && it.getAsFile();
        if (f && !/\.(srt|ass|ssa|vtt|txt)$/i.test(f.name)) return false;
      }
    }
    return true;
  }

  function isSubName(name) { return /\.(srt|ass|ssa)$/i.test(name || ''); }

  window.addEventListener('dragover', function (e) {
    if (!state.video || !hasSubFile(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    ensureOverlay();
    if (dropEl) dropEl.classList.add('show');
    state.lastRect = null;
    render(true);
  }, true);

  window.addEventListener('dragleave', function (e) {
    if (dropEl && (!e.relatedTarget || e.clientX <= 0 || e.clientY <= 0)) dropEl.classList.remove('show');
  }, true);

  window.addEventListener('drop', function (e) {
    if (dropEl) dropEl.classList.remove('show');
    if (!state.video || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    var file = null;
    for (var i = 0; i < e.dataTransfer.files.length; i++) {
      if (isSubName(e.dataTransfer.files[i].name)) { file = e.dataTransfer.files[i]; break; }
    }
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    loadFromFile(file);
  }, true);

  // ---------------- обмен с попапом и между фреймами ----------------

  // Плеер часто живёт во вложенном (в том числе чужом) фрейме. Content script
  // работает в каждом фрейме, а верхний фрейм собирает данные со всех дочерних
  // через postMessage и отдаёт попапу единый список.

  var FRAME_KEY = Math.random().toString(36).slice(2, 10);
  var RPC = 'sub-overlay-rpc-v1';
  var pending = {};
  var seq = 0;

  function videoList() {
    return state.videos.filter(function (v) { return v.isConnected; }).map(function (v) {
      var r = v.getBoundingClientRect();
      return {
        id: videoId(v),
        w: Math.round(r.width), h: Math.round(r.height),
        duration: isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
        active: v === state.video
      };
    });
  }

  function localInfo() {
    refreshVideos();
    return {
      frameKey: FRAME_KEY,
      url: location.href.slice(0, 150),
      isTop: window.top === window,
      videos: videoList(),
      sub: {
        hasSubs: state.cues.length > 0,
        count: state.cues.length,
        fileName: state.fileName,
        format: state.format,
        encoding: state.encoding,
        fromMemory: state.fromMemory,
        shift: state.shift,
        currentTime: state.video ? state.video.currentTime : 0,
        currentText: (state.lastHtml || '').replace(/<br>/g, ' / ').replace(/<[^>]+>/g, '')
      },
      settings: state.settings
    };
  }

  function childWindows() {
    var out = [];
    var els;
    try { els = document.querySelectorAll('iframe, frame'); } catch (e) { return out; }
    for (var i = 0; i < els.length; i++) {
      try { if (els[i].contentWindow) out.push(els[i].contentWindow); } catch (e) {}
    }
    return out;
  }

  function gather(cb, waitMs) {
    var id = FRAME_KEY + ':' + (++seq);
    var kids = childWindows();
    var box = { list: [localInfo()] };
    if (!kids.length) return cb(box.list);
    pending[id] = box;
    kids.forEach(function (w) {
      try { w.postMessage({ __subOverlay: RPC, kind: 'query', id: id }, '*'); } catch (e) {}
    });
    setTimeout(function () { delete pending[id]; cb(box.list); }, waitMs || 220);
  }

  // Сообщения приходят из любого окна, в том числе от скриптов самого сайта.
  // Поэтому принимаем только то, что пришло сверху (от родительского фрейма)
  // или снизу (ответ от собственного дочернего фрейма).
  function isParentWindow(src) {
    return !!src && src === window.parent && window.parent !== window;
  }
  function isChildWindow(src) {
    if (!src) return false;
    var kids = childWindows();
    for (var i = 0; i < kids.length; i++) if (kids[i] === src) return true;
    return false;
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__subOverlay !== RPC) return;
    if (d.kind === 'query') {
      if (!isParentWindow(e.source)) return;
      var src = e.source;
      gather(function (list) {
        try { src.postMessage({ __subOverlay: RPC, kind: 'reply', id: d.id, list: list }, '*'); } catch (err) {}
      }, 120);
    } else if (d.kind === 'reply') {
      if (!isChildWindow(e.source)) return;
      var box = pending[d.id];
      if (box && d.list && d.list.length) box.list = box.list.concat(d.list);
    } else if (d.kind === 'action') {
      if (!isParentWindow(e.source)) return;
      if (d.frameKey === FRAME_KEY) handleAction(d.msg);
      else childWindows().forEach(function (w) { try { w.postMessage(d, '*'); } catch (err) {} });
    }
  });

  function handleAction(msg) {
    if (!msg || !msg.type) return { ok: false };
    switch (msg.type) {
      case 'LOAD_TEXT':
        return loadFromText(msg.text, msg.name, msg.encoding);
      case 'SELECT_VIDEO':
        refreshVideos(msg.id);
        render(true);
        return { ok: true };
      case 'SET_SHIFT':
        if (typeof msg.delta === 'number') setShift(state.shift + msg.delta);
        else setShift(msg.value || 0);
        toast('Сдвиг: ' + (state.shift > 0 ? '+' : '') + state.shift.toFixed(2) + ' с');
        return { ok: true, shift: state.shift };
      case 'CLEAR':
        clearSubs();
        return { ok: true };
      default:
        return { ok: false };
    }
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      if (msg.type === 'OS_PING') {
        sendResponse({ ok: true, os: isOpenSubtitles(), url: location.href, ready: document.readyState });
        return true;
      }
      if (msg.type === 'OS_SHOWS' || msg.type === 'OS_COLLECT' || msg.type === 'OS_FETCH') {
        if (!isOpenSubtitles() || window.top !== window) return; // отвечает только страница сайта
        if (msg.type === 'OS_SHOWS') { sendResponse(osShows()); return true; }
        var work = msg.type === 'OS_COLLECT' ? osCollect() : osFetchSubtitle();
        work.then(sendResponse, function (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        });
        return true;
      }
      if (msg.type === 'PING') {
        gather(function (list) {
          sendResponse({ ok: true, href: location.href, frames: list });
        }, 240);
        return true;
      }
      if (msg.type === 'ACTION') {
        if (msg.frameKey && msg.frameKey !== FRAME_KEY) {
          var payload = { __subOverlay: RPC, kind: 'action', frameKey: msg.frameKey, msg: msg.msg };
          childWindows().forEach(function (w) { try { w.postMessage(payload, '*'); } catch (e) {} });
          sendResponse({ ok: true, routed: true });
        } else {
          var r = handleAction(msg.msg) || {};
          r.ok = r.ok !== false;
          sendResponse(r);
        }
        return true;
      }
    });
  } catch (e) {}

  // ---------------- opensubtitles.com: чтение страницы поиска ----------------

  // Работает только на самом сайте: расширение открывает нужную страницу
  // в фоновой вкладке, а разбор идёт здесь, уже в браузере пользователя.

  function isOpenSubtitles() {
    return /(^|\.)opensubtitles\.com$/.test(location.hostname);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function osCollect() {
    var res = await OpenSubs.collectPages(document, { sleep: sleep });
    return {
      ok: true,
      url: location.href,
      total: res.total,
      rows: res.rows,
      languages: res.languages.map(function (g) {
        return {
          code: g.code, name: g.name, label: g.label, count: g.count,
          downloads: g.downloads,
          best: g.best ? { url: g.best.url, release: g.best.release, downloads: g.best.downloads } : null
        };
      })
    };
  }

  function osShows() {
    return {
      ok: true,
      url: location.href,
      showId: OpenSubs.extractShowId(document),
      shows: OpenSubs.parseShows(document).slice(0, 20)
    };
  }

  // Ссылка на файл появляется после нажатия кнопки DOWNLOAD — сайт сам
  // подставляет её в разметку. Мы просто ждём её и читаем файл по ней.
  async function osFetchSubtitle() {
    function fileLink() {
      var links = document.querySelectorAll('a[download]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        if (!href || href === '#') continue;
        return links[i];
      }
      return null;
    }

    var link = fileLink();
    if (!link) {
      var trigger = document.querySelector('a.download-trigger, .download-trigger');
      if (trigger) trigger.click();
      for (var i = 0; i < 40 && !link; i++) {
        await sleep(250);
        link = fileLink();
      }
    }
    if (!link) {
      return { ok: false, error: 'Кнопка скачивания на странице не найдена — возможно, нужен вход на сайт.' };
    }

    var name = link.getAttribute('download') || 'subtitles.srt';
    var href = link.getAttribute('href');
    try {
      var res = await fetch(href, { credentials: 'include' });
      if (!res.ok) return { ok: false, error: 'Сайт ответил ошибкой ' + res.status };
      var buf = await res.arrayBuffer();
      var kind = OpenSubs.sniffPayload(buf);
      if (kind === 'zip' || kind === 'rar') {
        return { ok: false, error: 'Субтитры отдаются архивом (' + kind + ') — распакуйте и загрузите файл вручную.', url: location.href };
      }
      if (kind === 'html') {
        return { ok: false, error: 'Вместо файла пришла страница сайта: скорее всего исчерпан дневной лимит скачиваний или нужен вход.', url: location.href };
      }
      var dec = SubParse.decodeBytes(buf);
      var parsed = SubParse.parse(dec.text, name);
      if (!parsed.cues.length) return { ok: false, error: 'Файл скачался, но реплики в нём не распознаны.' };
      return { ok: true, name: name, text: dec.text, encoding: dec.encoding, count: parsed.cues.length };
    } catch (e) {
      return { ok: false, error: 'Не удалось скачать файл: ' + (e && e.message ? e.message : e) };
    }
  }

  // первичный поиск
  refreshVideos();
  ensureDiscoveryPoll();
  setTimeout(refreshVideos, 1000);
  setTimeout(refreshVideos, 3000);

  // для автотестов
  window.__subOverlay = {
    state: state,
    loadFromText: loadFromText,
    info: localInfo,
    setShift: setShift,
    refreshVideos: refreshVideos,
    getHost: function () { return host; }
  };
})();
