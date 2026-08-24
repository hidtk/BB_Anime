/*
 * subparse.js — парсинг субтитров (.srt / .ass / .ssa) и определение кодировки.
 * Никаких внешних зависимостей. Используется и в popup, и в content script.
 */
(function (root) {
  'use strict';

  // ---------- кодировки ----------

  function decodeBytes(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8 (BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
    try {
      var strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text: strict, encoding: 'utf-8' };
    } catch (e) {
      try {
        return { text: new TextDecoder('windows-1251').decode(bytes), encoding: 'windows-1251' };
      } catch (e2) {
        return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8 (с потерями)' };
      }
    }
  }

  function normalizeText(text) {
    return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  // ---------- разметка ----------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function emitRun(text, flags) {
    if (!text) return '';
    var html = escapeHtml(text).replace(/\n/g, '<br>');
    if (flags.i) html = '<i>' + html + '</i>';
    if (flags.b) html = '<b>' + html + '</b>';
    if (flags.u) html = '<u>' + html + '</u>';
    return html;
  }

  function srtTextToHtml(raw) {
    var src = String(raw).replace(/\{\\[^}]*\}/g, '');
    var flags = { i: false, b: false, u: false };
    var out = '';
    var re = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
    var last = 0, m;
    while ((m = re.exec(src)) !== null) {
      var buf = src.slice(last, m.index);
      last = re.lastIndex;
      var tag = m[2].toLowerCase();
      var closing = m[1] === '/';
      if (tag === 'i' || tag === 'b' || tag === 'u') {
        out += emitRun(buf, flags);
        flags[tag] = !closing;
      } else if (tag === 'br') {
        out += emitRun(buf, flags) + '<br>';
      } else {
        out += emitRun(buf, flags);
      }
    }
    out += emitRun(src.slice(last), flags);
    return out.trim();
  }

  function assTextToHtml(raw) {
    var src = String(raw);
    var flags = { i: false, b: false, u: false };
    var out = '';
    var i = 0;
    while (i < src.length) {
      var open = src.indexOf('{', i);
      if (open === -1) { out += emitRun(unescapeAssPlain(src.slice(i)), flags); break; }
      out += emitRun(unescapeAssPlain(src.slice(i, open)), flags);
      var close = src.indexOf('}', open);
      if (close === -1) break;
      applyAssTags(src.slice(open + 1, close), flags);
      i = close + 1;
    }
    return out.replace(/^(<br>)+/, '').replace(/(<br>)+$/, '').trim();
  }

  function unescapeAssPlain(s) {
    return s.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  }

  function applyAssTags(block, flags) {
    var re = /\\([ibu])([01])/g, m;
    while ((m = re.exec(block)) !== null) flags[m[1]] = m[2] === '1';
  }

  function isDrawingBlockLine(text) {
    return /\{[^}]*\\p[1-9]/.test(text);
  }

  // ---------- SRT ----------

  // миллисекунды не обязательны: встречаются файлы вида 00:00:01 --> 00:00:03
  var SRT_TIME = /(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;

  function hmsToSeconds(h, m, s, frac) {
    var f = 0;
    if (frac !== undefined && frac !== null && frac !== '') {
      f = parseInt(frac, 10) / Math.pow(10, String(frac).length);
    }
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + f;
  }

  function parseSRT(text) {
    var lines = normalizeText(text).split('\n');
    var cues = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = line.match(SRT_TIME);
      if (m) {
        if (cur) pushCue(cues, cur);
        cur = { start: hmsToSeconds(m[1], m[2], m[3], m[4]), end: hmsToSeconds(m[5], m[6], m[7], m[8]), lines: [] };
        continue;
      }
      if (!cur) continue;
      if (line.trim() === '') { pushCue(cues, cur); cur = null; continue; }
      if (/^\d+$/.test(line.trim()) && lines[i + 1] && SRT_TIME.test(lines[i + 1])) continue;
      cur.lines.push(line);
    }
    if (cur) pushCue(cues, cur);
    return finalize(cues);
  }

  function pushCue(cues, cur) {
    var raw = cur.lines.join('\n').trim();
    if (!raw) return;
    var html = srtTextToHtml(raw);
    if (!html) return;
    cues.push({ start: cur.start, end: cur.end, html: html });
  }

  // ---------- ASS / SSA ----------

  function parseASS(text) {
    var lines = normalizeText(text).split('\n');
    var inEvents = false;
    var fields = null;
    var textIndex = 9;
    var cues = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '[') { inEvents = /^\[events\]/i.test(line); continue; }
      if (!inEvents) continue;

      var colon = line.indexOf(':');
      if (colon === -1) continue;
      var key = line.slice(0, colon).trim().toLowerCase();
      var rest = line.slice(colon + 1);

      if (key === 'format') {
        fields = rest.split(',').map(function (s) { return s.trim().toLowerCase(); });
        var ti = fields.indexOf('text');
        textIndex = ti === -1 ? fields.length - 1 : ti;
        continue;
      }
      if (key !== 'dialogue') continue;

      var parts = rest.split(',');
      if (parts.length < textIndex + 1) continue;
      var startIdx = fields ? fields.indexOf('start') : 1;
      var endIdx = fields ? fields.indexOf('end') : 2;
      if (startIdx === -1) startIdx = 1;
      if (endIdx === -1) endIdx = 2;

      var start = parseAssTime(parts[startIdx]);
      var end = parseAssTime(parts[endIdx]);
      if (start === null || end === null) continue;

      var raw = parts.slice(textIndex).join(',');
      if (isDrawingBlockLine(raw)) continue;
      var html = assTextToHtml(raw);
      if (!html) continue;
      cues.push({ start: start, end: end, html: html });
    }
    return finalize(cues);
  }

  function parseAssTime(s) {
    if (s === undefined || s === null) return null;
    var m = String(s).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;
    return hmsToSeconds(m[1], m[2], m[3], m[4]);
  }

  // ---------- финализация ----------

  var MIN_DURATION = 1.2; // сек: столько показываем реплику с нулевой/битой длительностью

  function finalize(cues) {
    cues = cues.filter(function (c) {
      return isFinite(c.start) && isFinite(c.end) && c.start >= 0 && c.html;
    }).map(function (c) {
      if (c.end <= c.start) c.end = c.start + MIN_DURATION;
      return c;
    });
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var prev = out[out.length - 1];
      if (prev && prev.start === cues[i].start && prev.end === cues[i].end) {
        if (prev.html !== cues[i].html) prev.html += '<br>' + cues[i].html;
        continue;
      }
      out.push(cues[i]);
    }
    return out;
  }

  // Активные реплики на момент времени t. Двоичный поиск по началу + добор
  // назад, чтобы поймать перекрывающиеся реплики (частый случай в ASS).
  function findActive(cues, t) {
    if (!cues || !cues.length || !isFinite(t)) return [];
    var lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === -1) return [];
    var out = [];
    var guard = 0;
    for (var i = idx; i >= 0 && guard < 64; i--, guard++) {
      var c = cues[i];
      if (c.start <= t && c.end > t) out.unshift(c);
      else if (c.end <= t - 30) break; // дальше назад точно ничего активного нет
    }
    return out;
  }

  function activeHtml(cues, t) {
    var list = findActive(cues, t);
    if (!list.length) return '';
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      if (parts.indexOf(list[i].html) === -1) parts.push(list[i].html);
    }
    return parts.join('<br>');
  }

  function detectFormat(name, text) {
    var lower = String(name || '').toLowerCase();
    if (/\.(ass|ssa)$/.test(lower)) return 'ass';
    if (/\.srt$/.test(lower)) return 'srt';
    if (/\[script info\]/i.test(text) || /(^|\n)\s*dialogue\s*:/i.test(text)) return 'ass';
    return 'srt';
  }

  function parse(text, filename) {
    var t = normalizeText(text);
    var fmt = detectFormat(filename, t);
    var cues = fmt === 'ass' ? parseASS(t) : parseSRT(t);
    if (!cues.length) {
      var alt = fmt === 'ass' ? parseSRT(t) : parseASS(t);
      if (alt.length) { cues = alt; fmt = fmt === 'ass' ? 'srt' : 'ass'; }
    }
    return { format: fmt, cues: cues };
  }

  var API = {
    decodeBytes: decodeBytes,
    normalizeText: normalizeText,
    parse: parse,
    parseSRT: parseSRT,
    parseASS: parseASS,
    detectFormat: detectFormat,
    findActive: findActive,
    activeHtml: activeHtml,
    srtTextToHtml: srtTextToHtml,
    assTextToHtml: assTextToHtml
  };

  root.SubParse = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
