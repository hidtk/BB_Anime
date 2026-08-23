/* popup.js — управление: выбор видео (в том числе во фреймах), загрузка файла,
   сдвиг тайминга, настройки. */
(function () {
  'use strict';

  var DEFAULTS = {
    fontSizePct: 4.5, bottomPct: 10, bgOpacity: 0.45,
    color: '#ffffff', outline: true, rememberPerSite: true
  };

  var el = {
    status: document.getElementById('status'),
    diag: document.getElementById('diag'),
    videoSection: document.getElementById('videoSection'),
    videoSelect: document.getElementById('videoSelect'),
    pickBtn: document.getElementById('pickBtn'),
    fileInput: document.getElementById('fileInput'),
    fileInfo: document.getElementById('fileInfo'),
    clearBtn: document.getElementById('clearBtn'),
    shiftSection: document.getElementById('shiftSection'),
    shiftValue: document.getElementById('shiftValue'),
    resetShift: document.getElementById('resetShift'),
    currentLine: document.getElementById('currentLine'),
    fontSize: document.getElementById('fontSize'),
    fontSizeVal: document.getElementById('fontSizeVal'),
    bottomPct: document.getElementById('bottomPct'),
    bottomPctVal: document.getElementById('bottomPctVal'),
    bgOpacity: document.getElementById('bgOpacity'),
    bgOpacityVal: document.getElementById('bgOpacityVal'),
    outline: document.getElementById('outline'),
    remember: document.getElementById('remember')
  };

  var tabId = null;
  var target = null;      // {frameKey: string, videoId: number}
  var poll = 0;

  // ---------- связь со вкладкой ----------

  function tabsQuery(q) {
    return new Promise(function (r) { chrome.tabs.query(q, function (t) { r(t || []); }); });
  }
  function currentTab() {
    return new Promise(function (r) { chrome.tabs.getCurrent(function (t) { r(t && t.id); }); });
  }

  // Сообщение адресуем верхнему фрейму: он сам соберёт данные с дочерних.
  function sendTo(id, msg) {
    return new Promise(function (r) {
      chrome.tabs.sendMessage(id, msg, { frameId: 0 }, function (res) {
        if (chrome.runtime.lastError || !res) {
          // запасной путь: вдруг верхнего фрейма нет — спросим любой
          chrome.tabs.sendMessage(id, msg, function (res2) {
            if (chrome.runtime.lastError) return r(null);
            r(res2 || null);
          });
          return;
        }
        r(res);
      });
    });
  }

  function send(msg) {
    if (tabId == null) return Promise.resolve(null);
    return sendTo(tabId, msg);
  }

  function inject(id) {
    return new Promise(function (r) {
      if (!chrome.scripting) return r(false);
      chrome.scripting.executeScript(
        { target: { tabId: id == null ? tabId : id, allFrames: true }, files: ['src/subparse.js', 'src/content.js'] },
        function () { r(!chrome.runtime.lastError); }
      );
    });
  }

  async function resolveTab() {
    var own = await currentTab();
    var tabs = (await tabsQuery({ currentWindow: true })).filter(function (t) { return t.id !== own; });
    var active = tabs.filter(function (t) { return t.active; });
    var rest = tabs.filter(function (t) { return !t.active; });

    for (var i = 0; i < active.length; i++) {
      var res = await sendTo(active[i].id, { type: 'PING' });
      if (res) return { id: active[i].id, res: res };
    }
    if (active.length) {
      await inject(active[0].id);
      var res2 = await sendTo(active[0].id, { type: 'PING' });
      if (res2) return { id: active[0].id, res: res2 };
    }
    for (var j = 0; j < rest.length; j++) {
      var res3 = await sendTo(rest[j].id, { type: 'PING' });
      if (res3) return { id: rest[j].id, res: res3 };
    }
    return active.length ? { id: active[0].id, res: null } : { id: null, res: null };
  }

  function ping() { return send({ type: 'PING' }); }

  function action(msg) {
    if (!target) return Promise.resolve(null);
    return send({ type: 'ACTION', frameKey: target.frameKey, msg: msg });
  }

  // ---------- разбор ответа ----------

  function flatten(res) {
    var frames = (res && res.frames) || [];
    var videos = [];
    frames.forEach(function (f) {
      (f.videos || []).forEach(function (v) {
        videos.push({
          key: f.frameKey + ':' + v.id,
          frameKey: f.frameKey, id: v.id,
          w: v.w, h: v.h, duration: v.duration, paused: v.paused,
          activeInFrame: v.active, isTop: f.isTop, url: f.url
        });
      });
    });
    return { frames: frames, videos: videos };
  }

  function pickTarget(view) {
    // кандидаты — только фреймы, где реально есть видео
    var withVideo = view.frames.filter(function (f) { return (f.videos || []).length; });
    if (!withVideo.length) { target = null; return; }

    if (target) {
      var still = view.videos.filter(function (v) {
        return v.frameKey === target.frameKey && v.id === target.videoId;
      })[0];
      if (still) return;
      var sameFrame = withVideo.filter(function (f) { return f.frameKey === target.frameKey; })[0];
      if (sameFrame) {
        var v1 = sameFrame.videos.filter(function (v) { return v.active; })[0] || sameFrame.videos[0];
        target = { frameKey: sameFrame.frameKey, videoId: v1.id };
        return;
      }
    }
    // фрейм, где субтитры уже загружены
    var withSubs = withVideo.filter(function (f) { return f.sub && f.sub.hasSubs; })[0];
    if (withSubs) {
      var v0 = withSubs.videos.filter(function (v) { return v.active; })[0] || withSubs.videos[0];
      target = { frameKey: withSubs.frameKey, videoId: v0.id };
      return;
    }
    var best = view.videos.slice().sort(function (a, b) {
      return (b.activeInFrame ? 1 : 0) - (a.activeInFrame ? 1 : 0) || (b.w * b.h) - (a.w * a.h);
    })[0];
    target = { frameKey: best.frameKey, videoId: best.id };
  }

  function frameOf(view) {
    if (!target) return null;
    return view.frames.filter(function (f) { return f.frameKey === target.frameKey; })[0] || null;
  }

  function fmtShift(v) {
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2).replace('.', ',') + ' с';
  }

  function apply(res) {
    if (!res) {
      el.status.textContent = 'Нет связи со страницей. Обновите вкладку (F5) и откройте попап снова.';
      el.status.className = 'status warn';
      el.diag.textContent = '';
      el.videoSection.classList.add('hidden');
      el.shiftSection.classList.add('hidden');
      el.fileInfo.classList.add('hidden');
      el.clearBtn.classList.add('hidden');
      el.pickBtn.disabled = true;
      return;
    }
    el.pickBtn.disabled = false;
    var view = flatten(res);
    pickTarget(view);
    var frame = frameOf(view);
    var sub = frame && frame.sub ? frame.sub : null;
    var framesWithVideo = view.frames.filter(function (f) { return (f.videos || []).length; }).length;

    if (!view.videos.length) {
      el.status.textContent = 'Видео на странице не найдено. Запустите воспроизведение и откройте попап снова.';
      el.status.className = 'status warn';
      el.diag.textContent = 'Проверено областей страницы (фреймов): ' + view.frames.length +
        '. Если видео точно идёт — обновите вкладку клавишей F5 и попробуйте ещё раз.';
      el.videoSection.classList.add('hidden');
    } else {
      var inFrame = frame && !frame.isTop;
      el.status.textContent = 'Найдено видео: ' + view.videos.length +
        (inFrame ? ' (во фрейме)' : '') + (sub && sub.hasSubs ? ' • субтитры активны' : '');
      el.status.className = 'status good';
      el.diag.textContent = view.frames.length > 1
        ? 'Фреймов на странице: ' + view.frames.length + ', с видео: ' + framesWithVideo
        : '';

      if (view.videos.length > 1) {
        el.videoSection.classList.remove('hidden');
        var sig = view.videos.map(function (v) { return v.key + ':' + v.w + 'x' + v.h; }).join('|');
        if (el.videoSelect.dataset.sig !== sig) {
          el.videoSelect.dataset.sig = sig;
          el.videoSelect.innerHTML = '';
          view.videos.forEach(function (v, i) {
            var o = document.createElement('option');
            o.value = v.key;
            o.textContent = 'Видео ' + (i + 1) + ' — ' + v.w + '×' + v.h +
              (v.duration ? ', ' + Math.round(v.duration) + ' с' : '') +
              (v.isTop ? '' : ', во фрейме') + (v.paused ? '' : ' ▶');
            el.videoSelect.appendChild(o);
          });
        }
        if (target) el.videoSelect.value = target.frameKey + ':' + target.videoId;
      } else {
        el.videoSection.classList.add('hidden');
      }
    }

    if (sub && sub.hasSubs) {
      el.fileInfo.classList.remove('hidden');
      el.clearBtn.classList.remove('hidden');
      el.shiftSection.classList.remove('hidden');
      el.fileInfo.innerHTML = '';
      var b = document.createElement('b');
      b.textContent = sub.fileName || 'субтитры';
      el.fileInfo.appendChild(b);
      el.fileInfo.appendChild(document.createTextNode(
        ' — ' + sub.count + ' реплик, ' + String(sub.format || '').toUpperCase() +
        (sub.encoding ? ', ' + sub.encoding : '') + (sub.fromMemory ? ' (из памяти сайта)' : '')
      ));
      el.shiftValue.textContent = fmtShift(sub.shift || 0);
      el.currentLine.textContent = sub.currentText ? '«' + sub.currentText + '»' : '';
    } else {
      el.fileInfo.classList.add('hidden');
      el.clearBtn.classList.add('hidden');
      el.shiftSection.classList.add('hidden');
    }
  }

  // ---------- настройки ----------

  function applySettingsUI(s) {
    el.fontSize.value = s.fontSizePct;
    el.fontSizeVal.textContent = Number(s.fontSizePct).toFixed(1).replace('.', ',') + ' %';
    el.bottomPct.value = s.bottomPct;
    el.bottomPctVal.textContent = s.bottomPct + ' %';
    el.bgOpacity.value = s.bgOpacity;
    el.bgOpacityVal.textContent = Math.round(s.bgOpacity * 100) + ' %';
    el.outline.checked = !!s.outline;
    el.remember.checked = !!s.rememberPerSite;
  }

  function saveSettings(patch) {
    chrome.storage.sync.set(patch, function () { void chrome.runtime.lastError; });
  }

  el.fontSize.addEventListener('input', function () {
    el.fontSizeVal.textContent = Number(this.value).toFixed(1).replace('.', ',') + ' %';
    saveSettings({ fontSizePct: parseFloat(this.value) });
  });
  el.bottomPct.addEventListener('input', function () {
    el.bottomPctVal.textContent = this.value + ' %';
    saveSettings({ bottomPct: parseFloat(this.value) });
  });
  el.bgOpacity.addEventListener('input', function () {
    el.bgOpacityVal.textContent = Math.round(this.value * 100) + ' %';
    saveSettings({ bgOpacity: parseFloat(this.value) });
  });
  el.outline.addEventListener('change', function () { saveSettings({ outline: this.checked }); });
  el.remember.addEventListener('change', function () { saveSettings({ rememberPerSite: this.checked }); });

  // ---------- действия ----------

  el.pickBtn.addEventListener('click', function () { el.fileInput.click(); });

  el.fileInput.addEventListener('change', async function () {
    var file = this.files && this.files[0];
    if (!file) return;
    el.status.textContent = 'Читаю файл…';
    el.status.className = 'status';
    var buf = await file.arrayBuffer();
    var dec = SubParse.decodeBytes(buf);
    var parsed = SubParse.parse(dec.text, file.name);
    if (!parsed.cues.length) {
      el.status.textContent = 'Файл не распознан: нет ни SRT-блоков, ни строк Dialogue.';
      el.status.className = 'status warn';
      this.value = '';
      return;
    }
    if (!target) {
      var pre = await ping();
      apply(pre);
    }
    await action({ type: 'LOAD_TEXT', text: dec.text, name: file.name, encoding: dec.encoding });
    this.value = '';
    setTimeout(async function () { apply(await ping()); }, 150);
  });

  el.clearBtn.addEventListener('click', async function () {
    await action({ type: 'CLEAR' });
    apply(await ping());
  });

  el.resetShift.addEventListener('click', async function () {
    await action({ type: 'SET_SHIFT', value: 0 });
    apply(await ping());
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-shift]'), function (btn) {
    btn.addEventListener('click', async function () {
      await action({ type: 'SET_SHIFT', delta: parseFloat(btn.dataset.shift) });
      apply(await ping());
    });
  });

  el.videoSelect.addEventListener('change', async function () {
    var parts = String(this.value).split(':');
    target = { frameKey: parts[0], videoId: parseInt(parts[1], 10) };
    await action({ type: 'SELECT_VIDEO', id: target.videoId });
    apply(await ping());
  });

  // ---------- запуск ----------

  (async function init() {
    chrome.storage.sync.get(DEFAULTS, function (s) { applySettingsUI(Object.assign({}, DEFAULTS, s || {})); });
    var found = await resolveTab();
    if (found.id == null) {
      el.status.textContent = 'Откройте вкладку с видео.';
      el.status.className = 'status warn';
      el.pickBtn.disabled = true;
      return;
    }
    tabId = found.id;
    apply(found.res || await ping());
    poll = setInterval(async function () { apply(await ping()); }, 800);
    window.addEventListener('unload', function () { clearInterval(poll); });
  })();
})();
