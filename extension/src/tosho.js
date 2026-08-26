/*
 * tosho.js — субтитры с animetosho.org.
 *
 * Почему именно он: это агрегатор аниме-релизов, который вытаскивает из
 * них дорожки субтитров и выкладывает отдельными файлами. Ключ не нужен,
 * бот-защиты нет, а главное — у каждого релиза проставлены номера аниме и
 * серии из базы AniDB, поэтому серию можно найти точно, а не угадывать по
 * названию. Файлы лежат сжатыми в .xz — их распаковывает unxz.js.
 */
(function (root) {
  'use strict';

  var ORIGIN = 'https://animetosho.org';
  var FEED = 'https://feed.animetosho.org';

  // Группы, которые кладут в релиз отдельную дорожку субтитров (софтсаб).
  var GOOD_GROUPS = /(erai-raws|subsplease|horriblesubs|judas|asw|ember|anime time|coalgirls|commie|nyanpasu|beatrice)/i;

  var LANG3 = {
    eng: 'en', rus: 'ru', jpn: 'ja', ukr: 'uk', spa: 'es', por: 'pt', ger: 'de', deu: 'de',
    fre: 'fr', fra: 'fr', ita: 'it', ara: 'ar', pol: 'pl', chi: 'zh', zho: 'zh', kor: 'ko',
    tur: 'tr', dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', fin: 'fi', nor: 'no', heb: 'he',
    hun: 'hu', ces: 'cs', cze: 'cs', gre: 'el', ell: 'el', ind: 'id', vie: 'vi', tha: 'th',
    ron: 'ro', rum: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', lit: 'lt', lav: 'lv',
    est: 'et', fas: 'fa', per: 'fa', hin: 'hi', ben: 'bn', may: 'ms', msa: 'ms', cat: 'ca'
  };

  var transport = null;
  function setTransport(t) { transport = t || null; }

  function transportError(message) {
    var e = new Error(message);
    e.transportFailed = true;
    return e;
  }

  async function fetchText(url) {
    if (transport && transport.text) return await transport.text(url);
    var res;
    try {
      res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      throw transportError('Запрос к animetosho.org не прошёл: ' + ((e && e.message) || e));
    }
    if (!res.ok) throw transportError('animetosho.org ответил ошибкой ' + res.status);
    return await res.text();
  }

  async function fetchJson(url) {
    var text = await fetchText(url);
    try { return JSON.parse(text); }
    catch (e) { throw transportError('animetosho.org ответил не тем, чего ждали'); }
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function fetchBytes(url) {
    if (transport && transport.bytes) {
      var got = await transport.bytes(url);
      if (!got || !got.ok) throw transportError((got && got.error) || 'Файл не скачался.');
      return base64ToBytes(got.base64).buffer;
    }
    var res;
    try {
      res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      throw transportError('Файл не скачался: ' + ((e && e.message) || e));
    }
    if (!res.ok) throw transportError('Файл не отдался, сайт ответил ' + res.status + '.');
    return await res.arrayBuffer();
  }

  function parseDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function feedSearchUrl(query) {
    return FEED + '/json?only_tor=0&q=' + encodeURIComponent(query);
  }
  function feedEpisodeUrl(eid) {
    return FEED + '/json?only_tor=0&eid=' + String(eid).replace(/\D/g, '');
  }
  function viewUrl(id) {
    return ORIGIN + '/view/' + String(id).replace(/\D/g, '');
  }
  function htmlSearchUrl(query) {
    return ORIGIN + '/search?q=' + encodeURIComponent(query);
  }

  // Запасной путь: обычная страница поиска вместо json-ленты. Нужен, когда
  // запросы идут через вкладку сайта — с неё соседний домен ленты не виден.
  function parseSearchPage(doc) {
    var links = doc.querySelectorAll('a[href*="/view/"]');
    var seen = {};
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (!/animetosho\.org\/view\/|^\/view\//.test(href)) continue;
      var url = /^https?:/.test(href) ? href : ORIGIN + href;
      if (seen[url]) continue;
      seen[url] = true;
      var title = (links[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      out.push({ id: null, url: url, title: title, torrent_downloaded_count: 0 });
    }
    return out;
  }

  // Запросы, которыми ищем серию: с ведущим нулём и без, с номером сезона.
  function queriesFor(title, season, episode) {
    var t = String(title || '').replace(/\s+/g, ' ').trim();
    var e = parseInt(episode, 10);
    var s = parseInt(season, 10);
    var out = [];
    function add(q) {
      q = q.replace(/\s+/g, ' ').trim();
      if (q && out.indexOf(q) === -1) out.push(q);
    }
    if (!isFinite(e)) { add(t); return out; }
    add(t + ' ' + pad2(e));
    if (isFinite(s) && s > 1) {
      add(t + ' S' + pad2(s) + 'E' + pad2(e));
      add(t + ' ' + s + ' ' + pad2(e));
    }
    add(t + ' - ' + pad2(e));
    add(t + ' ' + e);
    return out;
  }

  // Из выдачи берём номер серии в базе AniDB: он у большинства релизов
  // одинаковый, и по нему находятся остальные раздачи той же серии.
  function dominantEid(entries) {
    var count = {};
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var eid = entries[i] && entries[i].anidb_eid;
      if (!eid) continue;
      count[eid] = (count[eid] || 0) + 1;
      if (!best || count[eid] > count[best]) best = eid;
    }
    return best ? String(best) : null;
  }

  function scoreEntry(entry) {
    var title = String(entry.title || '');
    var score = 0;
    if (GOOD_GROUPS.test(title)) score += 50;
    if (/\[(multiple subtitle|multi-?subs?)\]/i.test(title)) score += 20;
    if (/\.mkv$/i.test(title)) score += 10;          // в mp4 дорожек обычно нет
    score += Math.min(20, Math.round((entry.torrent_downloaded_count || 0) / 500));
    return score;
  }

  function rankEntries(entries) {
    return entries.slice().map(function (e, i) {
      return { entry: e, score: scoreEntry(e), order: i };
    }).sort(function (a, b) {
      return b.score - a.score || a.order - b.order;
    }).map(function (x) { return x.entry; });
  }

  // Вложения релиза: «English [eng, ASS]» → код языка и ссылка на файл.
  function parseAttachments(doc, release) {
    var links = doc.querySelectorAll('a[href*="/storage/attach/"]');
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var name = '';
      try { name = decodeURIComponent(href.split('/').pop() || ''); }
      catch (e) { name = href.split('/').pop() || ''; }
      if (!/\.(ass|ssa|srt|vtt)(\.xz)?$/i.test(name)) continue;

      var label = (links[i].textContent || '').replace(/\s+/g, ' ').trim();
      var m = /\[\s*([a-z]{3})\s*[,\]]/i.exec(label);
      var code3 = m ? m[1].toLowerCase() : '';
      var code = LANG3[code3] || '';
      if (!code) {
        var byName = /\.([a-z]{2,3})\.(ass|ssa|srt|vtt)(\.xz)?$/i.exec(name);
        if (byName) code = LANG3[byName[1].toLowerCase()] || byName[1].toLowerCase();
      }
      out.push({
        code: code || '?',
        name: name.replace(/\.xz$/i, ''),
        label: label.replace(/\s*\[[^\]]*\]\s*$/, '') || code,
        url: /^https?:/.test(href) ? href : ORIGIN + href,
        release: release || '',
        downloads: 0
      });
    }
    return out;
  }

  /*
   * Ищем субтитры к серии. Возвращаем то же, что и поиск на opensubtitles:
   * { ok, total, rows, languages } — попап не должен знать разницы.
   */
  async function searchEpisode(opts) {
    opts = opts || {};
    var title = String(opts.query || '').trim();
    var episode = parseInt(opts.episode, 10);
    var season = parseInt(opts.season, 10);
    var step = opts.onStep || function () {};
    var maxReleases = opts.maxReleases || 6;
    if (!title) throw new Error('Не задано название.');

    step('Ищу серию на animetosho.org…');
    var entries = [];
    var viaHtml = false;
    var queries = queriesFor(title, season, episode);
    for (var q = 0; q < queries.length && !entries.length; q++) {
      var found;
      try {
        found = await fetchJson(feedSearchUrl(queries[q]));
      } catch (e) {
        // лента живёт на соседнем домене; если до неё не достучаться,
        // читаем обычную страницу поиска
        if (!e || !e.transportFailed) throw e;
        viaHtml = true;
        found = parseSearchPage(parseDoc(await fetchText(htmlSearchUrl(queries[q]))));
      }
      if (Array.isArray(found) && found.length) entries = found;
    }
    if (!entries.length) throw new Error('На animetosho.org такой серии нет.');

    // уточняем по номеру серии из базы AniDB — так подхватываются раздачи,
    // названные иначе
    var eid = viaHtml ? null : dominantEid(entries);
    if (eid) {
      step('Собираю все раздачи этой серии…');
      var byEid = await fetchJson(feedEpisodeUrl(eid));
      if (Array.isArray(byEid) && byEid.length) {
        var seen = {};
        var merged = [];
        byEid.concat(entries).forEach(function (e) {
          if (!e || seen[e.id]) return;
          seen[e.id] = true;
          merged.push(e);
        });
        entries = merged;
      }
    }

    var ranked = rankEntries(entries).slice(0, maxReleases);
    var rows = [];
    var looked = 0;
    for (var i = 0; i < ranked.length; i++) {
      var e = ranked[i];
      step('Смотрю раздачу «' + String(e.title || '').slice(0, 40) + '»…');
      var doc;
      try { doc = parseDoc(await fetchText(e.url || viewUrl(e.id))); }
      catch (err) { if (err && err.transportFailed && looked) continue; throw err; }
      looked++;
      var got = parseAttachments(doc, String(e.title || ''));
      // чем выше раздача в рейтинге, тем «весомее» её файлы при выборе
      got.forEach(function (a) { a.downloads = ranked.length - i; });
      rows = rows.concat(got);
      // если нужный язык уже нашёлся у хорошей раздачи — дальше не ходим
      if (opts.stopAt && rows.some(function (a) { return a.code === opts.stopAt; })) break;
    }

    if (!rows.length) throw new Error('У найденных раздач нет отдельных файлов субтитров (обычно это значит, что субтитры вшиты в видео).');
    return { ok: true, eid: eid, rows: rows };
  }

  // Скачиваем вложение и приводим к тексту субтитров.
  async function download(url) {
    var buf = await fetchBytes(url);
    var bytes = new Uint8Array(buf);
    var name = 'subtitles.ass';
    try { name = decodeURIComponent(String(url).split('/').pop() || name).replace(/\.xz$/i, ''); }
    catch (e) {}

    if (root.UnXz && root.UnXz.isXz(bytes)) {
      var plain = root.UnXz.decompress(bytes);
      buf = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
    }
    var dec = root.SubParse.decodeBytes(buf);
    var parsed = root.SubParse.parse(dec.text, name);
    if (!parsed.cues.length) return { ok: false, error: 'Файл скачался, но реплики в нём не распознаны.' };
    return { ok: true, name: name, text: dec.text, encoding: dec.encoding, count: parsed.cues.length };
  }

  function handles(url) {
    return /^https?:\/\/([a-z0-9-]+\.)?animetosho\.org\//i.test(String(url || ''));
  }

  var API = {
    ORIGIN: ORIGIN,
    FEED: FEED,
    LANG3: LANG3,
    setTransport: setTransport,
    queriesFor: queriesFor,
    dominantEid: dominantEid,
    scoreEntry: scoreEntry,
    rankEntries: rankEntries,
    parseAttachments: parseAttachments,
    searchEpisode: searchEpisode,
    download: download,
    handles: handles,
    feedSearchUrl: feedSearchUrl,
    htmlSearchUrl: htmlSearchUrl,
    parseSearchPage: parseSearchPage,
    feedEpisodeUrl: feedEpisodeUrl,
    viewUrl: viewUrl
  };
  root.Tosho = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
