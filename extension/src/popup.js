/* popup.js — управление: выбор видео (в том числе во фреймах), загрузка файла,
   сдвиг тайминга, настройки. */
(function () {
  'use strict';

  var DEFAULTS = {
    fontSizePct: 4.5, bottomPct: 10, bgOpacity: 0.45,
    color: '#ffffff', outline: true, rememberPerSite: true, preferLang: 'en'
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
    remember: document.getElementById('remember'),
    reloadExt: document.getElementById('reloadExt'),
    verLine: document.getElementById('verLine')
  };

  function extVersion() {
    try { return chrome.runtime.getManifest().version || '?'; } catch (e) { return '?'; }
  }

  // Расширение, поставленное «распакованной папкой», Chrome перезапускает только
  // вручную. Пока этого не сделали, в страницы инжектится прежний код — попап
  // при этом уже новый, потому что читается с диска. Чиним одной кнопкой.
  function offerReload(pageVersion) {
    el.reloadExt.classList.remove('hidden');
    el.reloadExt.onclick = function () {
      el.reloadExt.disabled = true;
      el.reloadExt.textContent = 'Перезагружаю…';
      try { chrome.runtime.reload(); } catch (e) {
        el.status.textContent = 'Не вышло — перезагрузите расширение на chrome://extensions';
      }
    };
    el.diag.textContent = 'В страницах работает версия ' + (pageVersion || 'до 1.1') +
      ', а на диске уже ' + extVersion() + '. Нажмите кнопку выше, затем обновите вкладку с видео клавишей F5.';
  }

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
    // Ответ content script старой версии (до 1.1): поля frames там нет.
    // Так бывает, когда расширение обновили, а вкладку не перезагрузили —
    // Chrome оставляет в открытых вкладках прежний код.
    if (!res.frames) {
      el.status.textContent = 'В этой вкладке работает старая версия расширения.';
      el.status.className = 'status warn';
      offerReload(null);
      el.videoSection.classList.add('hidden');
      el.shiftSection.classList.add('hidden');
      el.fileInfo.classList.add('hidden');
      el.clearBtn.classList.add('hidden');
      el.pickBtn.disabled = true;
      return;
    }

    el.pickBtn.disabled = false;
    var view = flatten(res);

    // версия кода на странице против версии на диске
    var stale = view.frames.filter(function (f) {
      return f.version && f.version !== extVersion();
    })[0];
    if (stale) {
      el.status.textContent = 'В этой вкладке работает старая версия расширения.';
      el.status.className = 'status warn';
      offerReload(stale.version);
      el.videoSection.classList.add('hidden');
      el.shiftSection.classList.add('hidden');
      el.fileInfo.classList.add('hidden');
      el.clearBtn.classList.add('hidden');
      el.pickBtn.disabled = true;
      return;
    }
    el.reloadExt.classList.add('hidden');
    pickTarget(view);
    var frame = frameOf(view);
    var sub = frame && frame.sub ? frame.sub : null;
    var framesWithVideo = view.frames.filter(function (f) { return (f.videos || []).length; }).length;

    if (!view.videos.length) {
      el.status.textContent = 'Видео на странице не найдено. Нажмите Play и откройте попап снова.';
      el.status.className = 'status warn';
      el.diag.textContent = 'Проверено областей страницы (фреймов): ' + view.frames.length +
        '. На многих сайтах плеер создаётся только после запуска серии. Если видео уже идёт — обновите вкладку клавишей F5.';
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
    if (s.preferLang) os.lang.value = s.preferLang;
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


  // ---------- поиск на opensubtitles.com ----------

  var os = {
    toggle: document.getElementById('osToggle'),
    panel: document.getElementById('osPanel'),
    query: document.getElementById('osQuery'),
    season: document.getElementById('osSeason'),
    episode: document.getElementById('osEpisode'),
    search: document.getElementById('osSearch'),
    auto: document.getElementById('osAuto'),
    lang: document.getElementById('osLang'),
    showRow: document.getElementById('osShowRow'),
    show: document.getElementById('osShow'),
    status: document.getElementById('osStatus'),
    results: document.getElementById('osResults')
  };
  var osBusy = false;
  var osShows = [];

  function osSay(text, kind) {
    os.status.textContent = text || '';
    os.status.className = 'hint' + (kind === 'warn' ? ' warn' : '');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function tabsCreate(url) {
    return new Promise(function (r) { chrome.tabs.create({ url: url, active: false }, function (t) { r(t); }); });
  }
  function tabsUpdate(id, url) {
    return new Promise(function (r) { chrome.tabs.update(id, { url: url }, function (t) { void chrome.runtime.lastError; r(t); }); });
  }
  function tabsRemove(id) {
    return new Promise(function (r) { chrome.tabs.remove(id, function () { void chrome.runtime.lastError; r(); }); });
  }
  function sendTab(id, msg) {
    return new Promise(function (r) {
      chrome.tabs.sendMessage(id, msg, { frameId: 0 }, function (res) {
        if (chrome.runtime.lastError) return r(null);
        r(res || null);
      });
    });
  }
  function rememberTempTab(id) {
    try { chrome.storage.local.set({ osTempTab: id || null }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }
  function cleanupTempTab() {
    try {
      chrome.storage.local.get('osTempTab', function (res) {
        if (chrome.runtime.lastError) return;
        var id = res && res.osTempTab;
        if (id) { chrome.tabs.remove(id, function () { void chrome.runtime.lastError; }); rememberTempTab(null); }
      });
    } catch (e) {}
  }

  // Ждём, пока вкладка догрузится и в ней ответит наш content script.
  async function waitTabReady(id, timeoutMs) {
    var until = Date.now() + (timeoutMs || 20000);
    while (Date.now() < until) {
      var res = await sendTab(id, { type: 'OS_PING' });
      if (res && res.ok && res.ready === 'complete') return true;
      await sleep(400);
    }
    return false;
  }

  function renderShows(list) {
    osShows = list;
    if (list.length < 2) { os.show.classList.add('hidden'); os.showRow.classList.add('hidden'); return; }
    os.show.innerHTML = '';
    list.forEach(function (s, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = (s.isSeries ? 'Сериал: ' : 'Фильм: ') + s.title;
      os.show.appendChild(o);
    });
    os.show.classList.remove('hidden');
    os.showRow.classList.remove('hidden');
  }

  function renderLanguages(data) {
    os.results.innerHTML = '';
    var langs = (data && data.languages) || [];
    if (!langs.length) {
      var empty = document.createElement('div');
      empty.className = 'osempty';
      empty.textContent = 'Субтитров для этой серии не нашлось.';
      os.results.appendChild(empty);
      return;
    }
    langs.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'osrow';

      var lang = document.createElement('span');
      lang.className = 'lang';
      lang.textContent = l.label + (l.code ? ' (' + l.code + ')' : '');
      row.appendChild(lang);

      var cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = '×' + l.count;
      row.appendChild(cnt);

      var rel = document.createElement('span');
      rel.className = 'rel';
      rel.title = l.best ? l.best.release : '';
      rel.textContent = l.best ? l.best.release : '';
      row.appendChild(rel);

      if (l.best) {
        var take = document.createElement('button');
        take.textContent = 'Взять';
        take.title = 'Скачать и сразу наложить на видео';
        take.addEventListener('click', function () { osTake(l.best.url, take); });
        row.appendChild(take);

        var open = document.createElement('a');
        open.href = l.best.url;
        open.target = '_blank';
        open.rel = 'noreferrer';
        open.textContent = 'открыть';
        row.appendChild(open);
      }
      os.results.appendChild(row);
    });
  }

  async function osRun() {
    if (osBusy) return;
    var q = os.query.value.trim();
    if (!q) { osSay('Введите название сериала или фильма.', 'warn'); return; }
    var season = os.season.value.trim();
    var episode = os.episode.value.trim();

    osBusy = true;
    os.search.disabled = true;
    os.auto.disabled = true;
    os.results.innerHTML = '';
    var tab = null;
    var found = null;
    try {
      osSay('Открываю поиск на opensubtitles.com…');
      tab = await tabsCreate(OpenSubs.buildTitleSearchUrl(q));
      rememberTempTab(tab.id);
      if (!await waitTabReady(tab.id, 25000)) {
        throw new Error('Сайт не ответил. Откройте opensubtitles.com вручную один раз (принять cookie) и попробуйте снова.');
      }

      var url;
      if (season && episode) {
        var info = await sendTab(tab.id, { type: 'OS_SHOWS' });
        var list = ((info && info.shows) || []);
        var series = list.filter(function (s) { return s.isSeries; });
        var pool = series.length ? series : list;
        if (!pool.length) throw new Error('По этому названию на сайте ничего не нашлось.');
        renderShows(pool);
        var idx = parseInt(os.show.value, 10);
        var chosen = pool[isFinite(idx) && pool[idx] ? idx : 0];

        osSay('Открываю «' + chosen.title + '»…');
        await tabsUpdate(tab.id, chosen.url);
        if (!await waitTabReady(tab.id, 25000)) throw new Error('Страница сериала не открылась.');
        var showInfo = await sendTab(tab.id, { type: 'OS_SHOWS' });
        var showId = showInfo && showInfo.showId;
        if (!showId) throw new Error('Не удалось определить сериал в базе сайта.');
        url = OpenSubs.buildEpisodeSearchUrl(showId, season, episode);
        osSay('Смотрю сезон ' + season + ', серию ' + episode + '…');
        await tabsUpdate(tab.id, url);
        if (!await waitTabReady(tab.id, 25000)) throw new Error('Страница результатов не открылась.');
      } else {
        osSay('Собираю языки по названию (сезон и серию можно указать для точности)…');
      }

      var data = await sendTab(tab.id, { type: 'OS_COLLECT' });
      if (!data || !data.ok) throw new Error('Не удалось разобрать страницу результатов.');
      renderLanguages(data);
      var total = data.total ? data.total : data.rows.length;
      osSay('Найдено вариантов: ' + total + ', языков: ' + data.languages.length + '.');
      found = data;
    } catch (e) {
      osSay((e && e.message) || String(e), 'warn');
    } finally {
      if (tab) { await tabsRemove(tab.id); rememberTempTab(null); }
      os.search.disabled = false;
      os.auto.disabled = false;
      osBusy = false;
    }
    return found;
  }

  // Полный автомат: сама страница подсказывает сериал и серию, дальше
  // остаётся выбрать язык и скачать лучший по числу скачиваний вариант.
  async function osAutoRun() {
    if (osBusy) return;
    if (!target) { osSay('Сначала откройте вкладку с видео.', 'warn'); return; }
    osSay('Смотрю, что сейчас на экране…');
    var ctx = await send({ type: 'OS_CONTEXT' });
    if (!ctx || !ctx.title) {
      osSay('Не удалось понять, что за серия. Введите название и номер серии вручную.', 'warn');
      return;
    }
    os.query.value = ctx.title;
    if (ctx.season) os.season.value = ctx.season;
    if (ctx.episode) os.episode.value = ctx.episode;
    if (!ctx.episode) {
      osSay('Нашёл «' + ctx.title + '», но номер серии со страницы не читается — впишите его сам' +
        'и нажмите «Авто» ещё раз.', 'warn');
      return;
    }

    var data = await osRun();
    if (!data || !data.languages || !data.languages.length) return;

    var want = os.lang.value;
    var pick = data.languages.filter(function (l) { return l.code === want; })[0] ||
      data.languages.filter(function (l) { return String(l.code).split('-')[0] === want; })[0];
    if (!pick) {
      osSay('Субтитры есть, но не на «' + want + '». Выберите язык из списка ниже.', 'warn');
      return;
    }
    if (!pick.best) { osSay('Для этого языка не нашлось ссылки на файл.', 'warn'); return; }

    var fake = { textContent: '', disabled: false };
    await osTake(pick.best.url, fake);
  }

  async function osTake(subtitleUrl, btn) {
    if (osBusy) return;
    if (!target) { osSay('Сначала откройте вкладку с видео — субтитры некуда накладывать.', 'warn'); return; }
    osBusy = true;
    var old = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    var tab = null;
    try {
      osSay('Открываю страницу субтитров…');
      tab = await tabsCreate(subtitleUrl);
      rememberTempTab(tab.id);
      if (!await waitTabReady(tab.id, 25000)) throw new Error('Страница субтитров не открылась.');
      osSay('Скачиваю файл…');
      var res = await sendTab(tab.id, { type: 'OS_FETCH' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Скачать не удалось.');
      await action({ type: 'LOAD_TEXT', text: res.text, name: res.name, encoding: res.encoding });
      osSay('Загружено: ' + res.name + ' — ' + res.count + ' реплик.');
      setTimeout(async function () { apply(await ping()); }, 200);
    } catch (e) {
      osSay((e && e.message) || String(e), 'warn');
    } finally {
      if (tab) { await tabsRemove(tab.id); rememberTempTab(null); }
      btn.textContent = old;
      btn.disabled = false;
      osBusy = false;
    }
  }

  os.toggle.addEventListener('click', function () {
    os.panel.classList.toggle('hidden');
    if (!os.panel.classList.contains('hidden')) os.query.focus();
  });
  os.search.addEventListener('click', function () { osRun(); });
  os.auto.addEventListener('click', osAutoRun);
  os.lang.addEventListener('change', function () { saveSettings({ preferLang: this.value }); });
  [os.query, os.season, os.episode].forEach(function (el) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') osRun(); });
  });

  // ---------- запуск ----------

  (async function init() {
    chrome.storage.sync.get(DEFAULTS, function (s) { applySettingsUI(Object.assign({}, DEFAULTS, s || {})); });
    el.verLine.textContent = 'версия ' + extVersion();
    cleanupTempTab();
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
