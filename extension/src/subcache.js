/*
 * subcache.js — личный архив субтитров.
 *
 * Всё, что расширение однажды скачало, ложится в базу браузера и больше
 * не зависит ни от одного сайта: та же серия при пересмотре включается
 * мгновенно и без интернета. Это не «сервис для всех», а ваш собственный
 * кэш — как папка с файлами, только расширение помнит, что к чему.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'subOverlayCache';
  var DB_VERSION = 1;
  var STORE = 'subs';

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Ключ: сериал + сезон + серия + язык. Название нормализуем, чтобы
  // «Mushoku Tensei!» и «mushoku tensei» попадали в одну ячейку.
  function key(title, season, episode, lang) {
    var s = parseInt(season, 10);
    var e = parseInt(episode, 10);
    return [
      norm(title),
      isFinite(s) ? s : 0,
      isFinite(e) ? e : 0,
      String(lang || 'xx').toLowerCase()
    ].join('|');
  }

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('в этом браузере нет хранилища'));
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('savedAt', 'savedAt');
          store.createIndex('show', 'show');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('хранилище не открылось')); };
    });
  }

  function tx(mode, job) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        try { out = job(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () {
          db.close();
          // запрос к базе отдаёт результат в .result — в том числе пустой,
          // когда такой записи нет; всё остальное возвращаем как есть
          var isRequest = out && typeof out === 'object' && 'result' in out;
          resolve(isRequest ? out.result : out);
        };
        t.onerror = function () { db.close(); reject(t.error); };
        t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }

  function get(k) {
    return tx('readonly', function (store) { return store.get(k); })
      .then(function (row) { return row || null; })
      .catch(function () { return null; });
  }

  function put(k, value) {
    var row = Object.assign({}, value, {
      key: k,
      show: String(k).split('|')[0],
      savedAt: Date.now()
    });
    return tx('readwrite', function (store) { store.put(row); return row; })
      .then(function () { return row; })
      .catch(function () { return null; });
  }

  function remove(k) {
    return tx('readwrite', function (store) { store.delete(k); }).catch(function () { return null; });
  }

  function all() {
    return tx('readonly', function (store) { return store.getAll(); })
      .then(function (rows) { return rows || []; })
      .catch(function () { return []; });
  }

  // Сводка для попапа: сколько файлов и сколько всего весит.
  function stats() {
    return all().then(function (rows) {
      var bytes = 0;
      var shows = {};
      rows.forEach(function (r) {
        bytes += (r.text || '').length;
        shows[r.show] = true;
      });
      return { count: rows.length, bytes: bytes, shows: Object.keys(shows).length };
    });
  }

  function clear() {
    return tx('readwrite', function (store) { store.clear(); }).catch(function () { return null; });
  }

  var API = {
    DB_NAME: DB_NAME,
    norm: norm,
    key: key,
    get: get,
    put: put,
    remove: remove,
    all: all,
    stats: stats,
    clear: clear
  };
  root.SubCache = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
