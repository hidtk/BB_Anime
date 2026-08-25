/*
 * subzip.js — распаковка zip-архивов с субтитрами.
 * Многие каталоги отдают файл только архивом; внешних библиотек не берём,
 * распаковка идёт штатным DecompressionStream браузера (Chrome 103+).
 */
(function (root) {
  'use strict';

  var SUB_RE = /\.(srt|ass|ssa|vtt|sub)$/i;

  function u16(b, i) { return b[i] | (b[i + 1] << 8); }
  function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }

  // Читаем центральный каталог: в отличие от локальных заголовков там всегда
  // есть честные размеры, даже если архив писали потоком.
  function listEntries(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return [];
    var count = u16(bytes, eocd + 10);
    var start = u32(bytes, eocd + 16);
    var out = [];
    var p = start;
    for (var n = 0; n < count && p + 46 <= bytes.length; n++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var localOff = u32(bytes, p + 42);
      var name = '';
      try {
        name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      } catch (e) { name = ''; }
      out.push({ name: name, method: method, compSize: compSize, localOffset: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function entryData(bytes, entry) {
    var p = entry.localOffset;
    if (u32(bytes, p) !== 0x04034b50) return null;
    var nameLen = u16(bytes, p + 26);
    var extraLen = u16(bytes, p + 28);
    var dataStart = p + 30 + nameLen + extraLen;
    return bytes.subarray(dataStart, dataStart + entry.compSize);
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('Браузер не умеет распаковывать zip (нужен Chrome 103+)'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // Достаём из архива первый файл субтитров (или самый крупный из подходящих).
  function extractSubtitle(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!isZip(bytes)) return Promise.resolve(null);

    var entries = listEntries(bytes).filter(function (e) {
      return SUB_RE.test(e.name) && !/\/$/.test(e.name) && !/^__MACOSX/.test(e.name);
    });
    if (!entries.length) return Promise.resolve(null);

    entries.sort(function (a, b) {
      var pa = /\.(ass|ssa)$/i.test(a.name) ? 1 : 0;
      var pb = /\.(ass|ssa)$/i.test(b.name) ? 1 : 0;
      return pb - pa || b.compSize - a.compSize;
    });

    var entry = entries[0];
    var data = entryData(bytes, entry);
    if (!data) return Promise.resolve(null);

    var name = entry.name.split('/').pop();
    if (entry.method === 0) return Promise.resolve({ name: name, bytes: data });
    if (entry.method === 8) {
      return inflateRaw(data).then(function (out) { return { name: name, bytes: out }; });
    }
    return Promise.reject(new Error('Внутри архива непонятный метод сжатия (' + entry.method + ')'));
  }

  var API = { isZip: isZip, listEntries: listEntries, extractSubtitle: extractSubtitle };
  root.SubZip = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
