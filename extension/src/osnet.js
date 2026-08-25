/*
 * osnet.js — сетевая часть работы с opensubtitles.com.
 *
 * Раньше расширение открывало фоновую вкладку и читало страницу оттуда.
 * Это ломалось: вкладка не всегда успевала «дозреть», а таблица результатов
 * на сайте листается скриптом и в живой странице показывает только первую
 * страницу. Обычный fetch отдаёт готовый HTML сразу со всеми строками —
 * поэтому вся цепочка теперь делается запросами из попапа.
 */
(function (root) {
  'use strict';

  var OS = root.OpenSubs;
  var ORIGIN = 'https://www.opensubtitles.com';

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // Транспорт можно подменить: если прямой запрос из попапа не проходит
  // (Cloudflare, отсутствие прав), попап открывает одну вкладку сайта и
  // ходит по страницам через неё — запросы там уже свои, same-origin.
  var transport = null;

  function setTransport(t) { transport = t || null; }

  // Ошибка транспорта — это «сходить не получилось», а не «ничего не нашлось».
  // Попап по этому признаку повторяет ту же работу через вкладку сайта.
  function transportError(message) {
    var e = new Error(message);
    e.transportFailed = true;
    return e;
  }

  async function fetchText(url) {
    if (transport && transport.text) return await transport.text(url);
    var res;
    try {
      res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    } catch (e) {
      throw transportError('Запрос к opensubtitles.com не прошёл: ' + ((e && e.message) || e));
    }
    // 403 сайт отдаёт запросам от расширения (защита от ботов), 429 — при
    // частых запросах: и то и другое лечится походом через вкладку сайта.
    if (!res.ok) throw transportError('opensubtitles.com ответил ошибкой ' + res.status);
    return await res.text();
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Возвращает { bytes: ArrayBuffer, name: string }
  async function fetchBytes(url, fallbackName) {
    if (transport && transport.bytes) {
      var got = await transport.bytes(url);
      if (!got || !got.ok) throw transportError((got && got.error) || 'Файл не скачался.');
      return { bytes: base64ToBytes(got.base64).buffer, name: got.name || fallbackName };
    }
    var res;
    try {
      res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    } catch (e) {
      throw transportError('Файл не скачался: ' + ((e && e.message) || e));
    }
    if (!res.ok) throw transportError('Файл не отдался, сайт ответил ' + res.status + '.');
    return { bytes: await res.arrayBuffer(), name: nameFromHeaders(res, fallbackName) };
  }

  async function fetchDoc(url) {
    return parseDoc(await fetchText(url));
  }

  // ---- подбор названия ----

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // Варианты запроса: полное название, часть до двоеточия, без «season N».
  function titleVariants(title) {
    var out = [];
    function add(t) {
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) return;
      for (var i = 0; i < out.length; i++) if (norm(out[i]) === norm(t)) return;
      out.push(t);
    }
    add(title);
    var colon = String(title).split(/\s*[:：]\s*/);
    if (colon.length > 1) { add(colon[0]); add(colon.slice(1).join(' ')); }
    add(String(title).replace(/\b(\d(?:st|nd|rd|th)\s+)?season\s*\d*\b/gi, ' '));
    add(String(title).replace(/\b(part|cour)\s*\d+\b/gi, ' '));
    var words = String(title).split(/\s+/);
    if (words.length > 3) add(words.slice(0, 3).join(' '));
    return out;
  }

  function scoreShow(show, query) {
    var a = norm(show.title), b = norm(query);
    if (!a || !b) return 0;
    if (a === b) return 100;
    var byString = 0;
    if (a.indexOf(b) === 0 || b.indexOf(a) === 0) byString = 80;
    else if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) byString = 60;
    // доля слов запроса, встретившихся в названии: «Mushoku Tensei II:
    // Jobless Reincarnation» так остаётся близким родственником запроса
    var aw = a.split(' '), bw = b.split(' '), hit = 0;
    for (var i = 0; i < bw.length; i++) if (aw.indexOf(bw[i]) !== -1) hit++;
    var byWords = Math.round(70 * hit / Math.max(bw.length, 1));
    return Math.max(byString, byWords);
  }

  function rankShows(shows, query, wantSeries) {
    return shows.map(function (s) {
      var sc = scoreShow(s, query);
      if (wantSeries && s.isSeries) sc += 15;
      if (wantSeries && !s.isSeries) sc -= 10;
      return { show: s, score: sc };
    }).sort(function (x, y) { return y.score - x.score; }).map(function (x) { return x.show; });
  }

  // ---- шаги поиска ----

  async function findShows(query, wantSeries) {
    var variants = titleVariants(query);
    for (var i = 0; i < variants.length; i++) {
      var doc = await fetchDoc(OS.buildTitleSearchUrl(variants[i]));
      var shows = OS.parseShows(doc);
      if (wantSeries) {
        var series = shows.filter(function (s) { return s.isSeries; });
        if (series.length) return { shows: rankShows(series, query, true), used: variants[i], doc: doc };
      }
      if (shows.length) return { shows: rankShows(shows, query, !!wantSeries), used: variants[i], doc: doc };
    }
    return { shows: [], used: variants[0] || query, doc: null };
  }

  async function showIdOf(show) {
    var doc = await fetchDoc(show.url);
    return OS.extractShowId(doc);
  }

  function pack(rows, url) {
    rows = OS.dedupe(rows || []);
    return {
      ok: true,
      url: url || '',
      total: rows.length,
      rows: rows,
      languages: OS.groupByLanguage(rows).map(function (g) {
        return {
          code: g.code, name: g.name, label: g.label, count: g.count, downloads: g.downloads,
          best: g.best ? { url: g.best.url, release: g.best.release, downloads: g.best.downloads } : null
        };
      })
    };
  }

  async function rowsForEpisode(showId, season, episode) {
    var url = OS.buildEpisodeSearchUrl(showId, season, episode);
    var doc = await fetchDoc(url);
    return { rows: OS.parseResults(doc), url: url };
  }

  // Запасной путь: общий поиск по «название S01E03» — тоже отдаёт таблицу.
  async function rowsByQuery(query) {
    var url = OS.buildTitleSearchUrl(query);
    var doc = await fetchDoc(url);
    return { rows: OS.parseResults(doc), url: url };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /*
   * Полный поиск субтитров к серии. onStep — колбэк для строки состояния.
   * Возвращает объект того же вида, что раньше приходил из вкладки.
   */
  async function searchEpisode(opts) {
    var query = String(opts.query || '').trim();
    var season = parseInt(opts.season, 10);
    var episode = parseInt(opts.episode, 10);
    var step = opts.onStep || function () {};
    var hasEp = isFinite(episode);
    if (!query) throw new Error('Не задано название.');

    if (!hasEp) {
      step('Ищу по названию…');
      var byName = await rowsByQuery(query);
      if (!byName.rows.length) throw new Error('По названию «' + query + '» субтитры не нашлись.');
      return pack(byName.rows, byName.url);
    }

    step('Ищу сериал «' + query + '» на opensubtitles.com…');
    var found = await findShows(query, true);
    if (!found.shows.length) {
      // сериала нет в базе — пробуем общий поиск по названию с номером серии
      step('Сериал не найден, пробую прямой поиск серии…');
      var direct = await rowsByQuery(query + ' S' + pad2(isFinite(season) ? season : 1) + 'E' + pad2(episode));
      if (direct.rows.length) return pack(direct.rows, direct.url);
      throw new Error('На сайте нет такого сериала. Проверьте название (можно вписать английское) и попробуйте снова.');
    }

    var tried = [];
    var ordered = found.shows.slice();
    if (opts.preferShow && opts.preferShow.url) {
      ordered = [opts.preferShow].concat(ordered.filter(function (x) { return x.url !== opts.preferShow.url; }));
    }
    var candidates = ordered.slice(0, 3);
    for (var i = 0; i < candidates.length; i++) {
      var show = candidates[i];
      step('Открываю «' + show.title + '»…');
      var id = null;
      try { id = await showIdOf(show); } catch (e) { id = null; }
      if (!id) { tried.push(show.title + ' (нет id)'); continue; }

      var seasons = [];
      if (isFinite(season)) seasons.push(season);
      if (seasons.indexOf(1) === -1) seasons.push(1);
      for (var s = 0; s < seasons.length; s++) {
        step('Смотрю сезон ' + seasons[s] + ', серию ' + episode + '…');
        var got = await rowsForEpisode(id, seasons[s], episode);
        if (got.rows.length) {
          var res = pack(got.rows, got.url);
          res.show = show;
          res.season = seasons[s];
          res.episode = episode;
          res.shows = found.shows;
          return res;
        }
        tried.push(show.title + ' S' + seasons[s] + 'E' + episode + ' — пусто');
      }
    }

    step('Пробую прямой поиск по названию серии…');
    var last = await rowsByQuery(query + ' S' + pad2(isFinite(season) ? season : 1) + 'E' + pad2(episode));
    if (last.rows.length) { var r2 = pack(last.rows, last.url); r2.shows = found.shows; return r2; }

    var e = new Error('Субтитров к этой серии на сайте нет. Проверил: ' + tried.slice(0, 4).join('; ') + '.');
    e.shows = found.shows;
    throw e;
  }

  // ---- скачивание файла ----

  function downloadHref(doc, pageUrl) {
    var sel = ['a[download][href]', 'a[href*="/subtitleserve/"]', 'a[href*="/download/"]'];
    for (var i = 0; i < sel.length; i++) {
      var a = doc.querySelector(sel[i]);
      var href = a && a.getAttribute('href');
      if (href && href !== '#') return { url: OS.absolute(href), name: (a.getAttribute('download') || '') };
    }
    var m = /\/subtitles\/(\d+)/.exec(String(pageUrl || ''));
    if (m) return { url: ORIGIN + '/en/subtitleserve/sub/' + m[1], name: '' };
    return null;
  }

  function nameFromHeaders(res, fallback) {
    var cd = res.headers.get('content-disposition') || '';
    var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return fallback;
  }

  // Скачивает и разбирает файл субтитров по адресу страницы субтитров.
  async function download(pageUrl) {
    var doc = await fetchDoc(pageUrl);
    var link = downloadHref(doc, pageUrl);
    if (!link) return { ok: false, error: 'На странице субтитров не нашлось ссылки на файл.' };

    var got = await fetchBytes(link.url, link.name || 'subtitles.srt');
    var name = link.name || got.name || 'subtitles.srt';
    var buf = got.bytes;
    var kind = OS.sniffPayload(buf);

    if (kind === 'zip') {
      var unpacked = null;
      try { unpacked = await root.SubZip.extractSubtitle(buf); } catch (e) { unpacked = null; }
      if (!unpacked) return { ok: false, error: 'Внутри архива не нашлось файла субтитров.' };
      name = unpacked.name || name;
      buf = unpacked.bytes.buffer.slice(unpacked.bytes.byteOffset,
        unpacked.bytes.byteOffset + unpacked.bytes.byteLength);
    } else if (kind === 'rar') {
      return { ok: false, error: 'Субтитры лежат в rar — такой архив расширение не открывает.' };
    } else if (kind === 'html') {
      return { ok: false, error: 'Вместо файла пришла страница сайта: похоже, исчерпан дневной лимит скачиваний или нужен вход на opensubtitles.com.' };
    }

    var dec = root.SubParse.decodeBytes(buf);
    var parsed = root.SubParse.parse(dec.text, name);
    if (!parsed.cues.length) return { ok: false, error: 'Файл скачался, но реплики в нём не распознаны.' };
    return { ok: true, name: name, text: dec.text, encoding: dec.encoding, count: parsed.cues.length };
  }

  var API = {
    ORIGIN: ORIGIN,
    fetchDoc: fetchDoc,
    transportError: transportError,
    fetchBytes: fetchBytes,
    setTransport: setTransport,
    parseDoc: parseDoc,
    norm: norm,
    titleVariants: titleVariants,
    scoreShow: scoreShow,
    rankShows: rankShows,
    downloadHref: downloadHref,
    searchEpisode: searchEpisode,
    download: download,
    pack: pack
  };

  root.OsNet = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
