/*
 * opensubs.js — работа с opensubtitles.com: сборка URL, разбор страницы
 * результатов, группировка по языкам. Никаких сетевых запросов отсюда:
 * страницы читает content script прямо в браузере пользователя.
 */
(function (root) {
  'use strict';

  var ORIGIN = 'https://www.opensubtitles.com';

  // Русские названия для частых языков; для остальных берём то, что даёт сайт.
  var LANG_RU = {
    en: 'английский', ru: 'русский', ja: 'японский', uk: 'украинский',
    de: 'немецкий', fr: 'французский', es: 'испанский', it: 'итальянский',
    pt: 'португальский', 'pt-PT': 'португальский', 'pt-BR': 'португальский (BR)',
    pl: 'польский', cs: 'чешский', sk: 'словацкий', tr: 'турецкий',
    ar: 'арабский', zh: 'китайский', 'zh-CN': 'китайский (упр.)', 'zh-TW': 'китайский (трад.)',
    ko: 'корейский', nl: 'нидерландский', sv: 'шведский', no: 'норвежский',
    da: 'датский', fi: 'финский', el: 'греческий', he: 'иврит', hi: 'хинди',
    hu: 'венгерский', ro: 'румынский', bg: 'болгарский', sr: 'сербский',
    hr: 'хорватский', sl: 'словенский', et: 'эстонский', lv: 'латышский',
    lt: 'литовский', vi: 'вьетнамский', th: 'тайский', id: 'индонезийский',
    fa: 'персидский', bn: 'бенгальский', ms: 'малайский', ca: 'каталанский'
  };

  function langLabel(code, siteName) {
    var ru = LANG_RU[code] || LANG_RU[String(code).split('-')[0]];
    if (ru) return ru;
    // сайт иногда отдаёт название, которое в консоли выглядит как ????? —
    // в таком случае показываем хотя бы код языка
    if (siteName && /^[?\s]+$/.test(siteName)) return code || 'неизвестный';
    return siteName || code || 'неизвестный';
  }

  function slugQuery(q) {
    return encodeURIComponent(String(q || '').trim().replace(/\s+/g, '+'));
  }

  // Поиск сериала/фильма по названию — со страницы берём кандидатов-сериалов.
  function buildTitleSearchUrl(query) {
    return ORIGIN + '/en/all/search-all/q-' + slugQuery(query) +
      '/hearing_impaired-include/machine_translated-/trusted_sources-';
  }

  // Все субтитры конкретной серии на всех языках.
  function buildEpisodeSearchUrl(showId, season, episode) {
    var s = parseInt(season, 10), e = parseInt(episode, 10);
    return ORIGIN + '/en/all/search-tvshows/q-osdb:' + String(showId).replace(/\D/g, '') +
      '/hearing_impaired-/machine_translated-/trusted_sources-' +
      '/season-' + (isFinite(s) ? s : '') + '/episode-' + (isFinite(e) ? e : '');
  }

  function absolute(href) {
    if (!href) return '';
    if (/^https?:/.test(href)) return href;
    return ORIGIN + (href.charAt(0) === '/' ? '' : '/') + href;
  }

  // Идентификатор сериала в базе сайта: встречается в ссылках вида q-osdb:1326008
  function extractShowId(htmlOrDoc) {
    var text = typeof htmlOrDoc === 'string'
      ? htmlOrDoc
      : (htmlOrDoc && htmlOrDoc.documentElement ? htmlOrDoc.documentElement.innerHTML : '');
    var m = /osdb:(\d{3,10})/.exec(text || '');
    return m ? m[1] : null;
  }

  // Кандидаты-сериалы со страницы поиска по названию.
  function parseShows(doc) {
    var seen = {};
    var out = [];
    var links = doc.querySelectorAll('a[href*="/tvshows/"], a[href*="/movies/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      // отсекаем навигацию вида /en/tvshows/popular
      if (!/\/(tvshows|movies)\/\d{4}-/.test(href)) continue;
      if (seen[href]) continue;
      seen[href] = true;
      var title = (links[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) {
        var img = links[i].querySelector('img');
        title = img ? (img.getAttribute('alt') || '') : '';
      }
      out.push({
        title: title || href.split('/').pop().replace(/-/g, ' '),
        url: absolute(href),
        isSeries: /\/tvshows\//.test(href)
      });
    }
    return out;
  }

  // Строки таблицы результатов. Разметка сайта: в первой ячейке ссылка с
  // кодом языка в скрытом span и человеческим названием в data-original-title.
  function parseResults(doc) {
    var rows = [];
    var trs = doc.querySelectorAll('table tbody tr');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var cells = tr.children;
      if (!cells.length) continue;
      var langA = cells[0].querySelector('a[href*="/subtitles/"]');
      if (!langA) continue;

      var hidden = langA.querySelector('span');
      var flag = langA.querySelector('i[class*="flag"]');
      var code = (hidden && hidden.textContent.trim()) || '';
      if (!code && flag) {
        var m = /flag\s+([a-z]{2}(?:-[a-zA-Z]{2})?)/.exec(flag.className || '');
        code = m ? m[1] : '';
      }
      var siteName = langA.getAttribute('data-original-title') || langA.getAttribute('title') || '';

      var relCell = cells[1] || null;
      var relA = relCell ? relCell.querySelector('a[href*="/subtitles/"]') : null;
      // В ячейке названия сайт держит два варианта строки — для узкого и
      // широкого экрана, — поэтому textContent ячейки склеивает их вместе.
      // Берём <em> (там чистое имя релиза), иначе самый длинный <span>.
      var release = '';
      var em = relCell ? relCell.querySelector('em') : null;
      if (em) release = em.textContent || '';
      if (!release && relA) {
        var spans = relA.querySelectorAll('span');
        for (var s = 0; s < spans.length; s++) {
          var t = spans[s].textContent || '';
          if (t.length > release.length) release = t;
        }
        if (!release) release = relA.textContent || '';
      }
      if (!release && relCell) release = relCell.textContent || '';
      release = release.replace(/\s+/g, ' ').trim();

      var numbers = [];
      for (var c = 0; c < cells.length; c++) {
        var t = (cells[c].textContent || '').trim();
        if (/^\d{1,7}$/.test(t)) numbers.push(parseInt(t, 10));
      }

      rows.push({
        code: code,
        name: siteName,
        label: langLabel(code, siteName),
        url: absolute((relA || langA).getAttribute('href')),
        release: release.slice(0, 120),
        downloads: numbers.length ? numbers[numbers.length - 1] : 0
      });
    }
    return rows;
  }

  // Сколько всего результатов обещает сайт («Showing 1 to 15 of 41 entries»).
  function totalEntries(doc) {
    var el = doc.querySelector('[id$="_info"], [class*="dataTables_info"]');
    if (!el) return null;
    var m = /of\s+([\d\s,]+)\s+entries/i.exec(el.textContent || '');
    return m ? parseInt(m[1].replace(/\D/g, ''), 10) : null;
  }

  // Кнопка «следующая страница» в таблице результатов (DataTables).
  function nextPageButton(doc) {
    var candidates = doc.querySelectorAll(
      '.paginate_button.next, li.next > a, .pagination li:last-child a, .pagination a'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var txt = (el.textContent || '').trim().toLowerCase();
      var cls = ((el.className || '') + ' ' + ((el.parentNode && el.parentNode.className) || '')).toLowerCase();
      if (cls.indexOf('disabled') !== -1) continue;
      if (/next|›|»|→|след/.test(txt) || /\bnext\b/.test(cls)) return el;
    }
    return null;
  }

  function firstRowSignature(doc) {
    var tr = doc.querySelector('table tbody tr');
    return tr ? (tr.textContent || '').slice(0, 120) : '';
  }

  // Проходим все страницы результатов: сайт листает таблицу на клиенте,
  // поэтому просто жмём «Next», пока строки меняются.
  function collectPages(doc, opts) {
    opts = opts || {};
    var wait = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var maxPages = opts.maxPages || 25;
    var total = totalEntries(doc);
    var rows = [];

    function step(page) {
      rows = dedupe(rows.concat(parseResults(doc)));
      if (page >= maxPages) return Promise.resolve();
      if (total && rows.length >= total) return Promise.resolve();
      var next = nextPageButton(doc);
      if (!next) return Promise.resolve();
      var before = firstRowSignature(doc);
      next.click();
      var tries = 0;
      function settle() {
        if (firstRowSignature(doc) !== before || tries++ >= 25) return step(page + 1);
        return wait(100).then(settle);
      }
      return wait(100).then(settle);
    }

    return step(1).then(function () {
      return { rows: rows, total: total, languages: groupByLanguage(rows) };
    });
  }

  function groupByLanguage(rows) {
    var map = {};
    var order = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var key = r.code || r.name || '?';
      if (!map[key]) {
        map[key] = { code: r.code, name: r.name, label: r.label, count: 0, downloads: 0, best: null, items: [] };
        order.push(key);
      }
      var g = map[key];
      g.count++;
      g.downloads += r.downloads || 0;
      g.items.push(r);
      if (!g.best || (r.downloads || 0) > (g.best.downloads || 0)) g.best = r;
    }
    return order.map(function (k) { return map[k]; }).sort(function (a, b) {
      return b.count - a.count || b.downloads - a.downloads ||
        String(a.label).localeCompare(String(b.label));
    });
  }

  function dedupe(rows) {
    var seen = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].url + '|' + rows[i].code;
      if (seen[k]) continue;
      seen[k] = true;
      out.push(rows[i]);
    }
    return out;
  }

  // Что именно нам отдали по ссылке скачивания: субтитры, архив или страница
  // сайта (лимит, капча, требование входа).
  function sniffPayload(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'zip';
    if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72) return 'rar';
    var head = '';
    for (var i = 0; i < Math.min(b.length, 400); i++) head += String.fromCharCode(b[i]);
    if (/^\s*(<!doctype html|<html)/i.test(head)) return 'html';
    return 'subtitle';
  }

  // ---- что именно сейчас смотрят: название, сезон, серия ----

  var JUNK_TITLE = /(watch|online|free|hd|sub\s*&?\s*dub|смотреть|онлайн|бесплатно)/gi;

  function cleanTitle(raw) {
    var t = String(raw || '');
    t = t.split(/\s+[—–|·]\s+/)[0];
    t = t.replace(/\(\d{4}\)/g, ' ');
    t = t.replace(/[sS]\d{1,2}[\s._-]?[eE]\d{1,3}/g, ' ');
    t = t.replace(/\b(episode|серия|эпизод)\s*\d{1,3}\b/gi, ' ');
    // технические хвосты вроде «1080p WEB-DL x265»
    t = t.replace(/\b\d{3,4}[pi]\b/gi, ' ');
    t = t.replace(/\b(web-?dl|webrip|bd-?rip|bluray|hdtv|x26[45]|hevc|aac|flac|dual audio|multi-?subs?|dub|sub)\b/gi, ' ');
    t = t.replace(JUNK_TITLE, ' ');
    t = t.replace(/[_.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    t = t.replace(/[:\-–—]+$/, '').trim();
    return t;
  }

  // url и заголовок обязательны, doc — если есть доступ к странице (так точнее)
  function detectEpisode(url, title, doc) {
    var res = { title: '', season: null, episode: null, from: '' };
    var hay = String(url || '') + ' \n ' + String(title || '');
    var m = /[sS](\d{1,2})[\s._-]?[eE](\d{1,3})/.exec(hay);
    if (m) { res.season = parseInt(m[1], 10); res.episode = parseInt(m[2], 10); res.from = 'S..E..'; }

    if (res.episode === null) {
      m = /season[-_/ ]?(\d{1,2})[^\d]{0,12}episode[-_/ ]?(\d{1,3})/i.exec(hay);
      if (m) { res.season = parseInt(m[1], 10); res.episode = parseInt(m[2], 10); res.from = 'season/episode'; }
    }
    if (res.episode === null) {
      m = /(?:episode|серия|эпизод)[-_/ ]?(\d{1,3})/i.exec(hay);
      if (m) { res.episode = parseInt(m[1], 10); res.from = 'episode N'; }
    }
    if (res.episode === null) {
      m = /[?&](?:ep|episode)=(\d{1,3})\b/i.exec(hay);
      if (m) { res.episode = parseInt(m[1], 10); res.from = 'параметр в ссылке'; }
    }

    if (doc) {
      if (res.episode === null) {
        var nodes = doc.querySelectorAll('button, a, li');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var txt = (el.textContent || '').trim();
          if (!/^\d{1,3}$/.test(txt)) continue;
          var cls = (el.className || '') + ' ' + (el.getAttribute('aria-current') || '') +
            ' ' + (el.getAttribute('data-state') || '');
          if (/active|current|selected|bg-primary|bg-orange|is-active/i.test(cls)) {
            res.episode = parseInt(txt, 10);
            res.from = 'выбранная серия на странице';
            break;
          }
        }
      }
      var og = doc.querySelector('meta[property="og:title"], meta[name="title"]');
      var h1 = doc.querySelector('h1');
      res.title = cleanTitle((og && og.getAttribute('content')) || (h1 && h1.textContent) || '');
    }

    if (!res.title) res.title = cleanTitle(title);
    if (!res.title && url) {
      var slug = /\/(?:anime|tv|series|title|watch)\/([a-z0-9-]+)/i.exec(String(url));
      if (slug) res.title = cleanTitle(slug[1].replace(/-\d+$/, '').replace(/-/g, ' '));
    }
    if (res.episode !== null && res.season === null) res.season = 1;
    return res;
  }

  var API = {
    ORIGIN: ORIGIN,
    LANG_RU: LANG_RU,
    langLabel: langLabel,
    buildTitleSearchUrl: buildTitleSearchUrl,
    buildEpisodeSearchUrl: buildEpisodeSearchUrl,
    extractShowId: extractShowId,
    parseShows: parseShows,
    parseResults: parseResults,
    totalEntries: totalEntries,
    groupByLanguage: groupByLanguage,
    nextPageButton: nextPageButton,
    collectPages: collectPages,
    dedupe: dedupe,
    sniffPayload: sniffPayload,
    detectEpisode: detectEpisode,
    cleanTitle: cleanTitle,
    absolute: absolute
  };

  root.OpenSubs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
