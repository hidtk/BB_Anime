/*
 * unit.js — быстрые тесты пайплайна «байты → текст → реплики → показ».
 * Без зависимостей и без браузера: node unit.js
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'extension', 'src', 'subparse.js'));

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('PASS  ' + name); }
  else { failures.push(name); console.log('FAIL  ' + name + '\n      ожидалось: ' + e + '\n      получено:  ' + a); }
}
function ok(name, cond, info) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failures.push(name); console.log('FAIL  ' + name + (info ? '  → ' + info : '')); }
}
const bytes = (s, enc) => Buffer.from(s, enc || 'utf8');

(async function () {

// ---------- кодировки ----------

check('UTF-8 без BOM', S.decodeBytes(bytes('Привет')).encoding, 'utf-8');
check('UTF-8 с BOM: маркер срезан',
  S.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('Привет')])).text, 'Привет');
check('UTF-8 с BOM: кодировка названа',
  S.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('x')])).encoding, 'utf-8 (BOM)');
{
  // «Ёжик» в windows-1251: Ё=0xA8, ж=0xE6, и=0xE8, к=0xEA — невалидный UTF-8
  const win1251 = Buffer.from([0xa8, 0xe6, 0xe8, 0xea]);
  const d = S.decodeBytes(win1251);
  check('windows-1251 определяется по невалидному UTF-8', [d.encoding, d.text], ['windows-1251', 'Ёжик']);
}
{
  const win1251 = Buffer.from([0xd1, 0xf3, 0xe1, 0xf2, 0xe8, 0xf2, 0xf0, 0xfb]); // «Субтитры»
  check('windows-1251 читается без кракозябр', S.decodeBytes(win1251).text, 'Субтитры');
}
{
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Тест', 'utf16le')]);
  const d = S.decodeBytes(utf16);
  check('UTF-16LE с BOM', [d.text, d.encoding], ['Тест', 'utf-16le']);
}

// ---------- SRT ----------

{
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nПервая строка\r\nвторая строка\r\n\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n<i>Курсив</i> и <b>жирный</b>\r\n';
  const r = S.parse(srt, 'a.srt');
  check('SRT: формат распознан', r.format, 'srt');
  check('SRT: BOM, CRLF и лишние пустые строки не мешают', r.cues.length, 2);
  check('SRT: тайминги', [r.cues[0].start, r.cues[0].end], [1, 3.5]);
  check('SRT: многострочная реплика', r.cues[0].html, 'Первая строка<br>вторая строка');
  check('SRT: курсив и жирный сохранены', r.cues[1].html, '<i>Курсив</i> и <b>жирный</b>');
}
check('SRT: тег <font> вырезан, текст остался',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\n<font color="#fff">Текст</font>\n', 'a.srt').cues[0].html, 'Текст');
check('SRT: незакрытый тег не ломает разметку',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\n<i>Косой текст\n', 'a.srt').cues[0].html, '<i>Косой текст</i>');
check('SRT: угловые скобки в тексте экранируются',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\n5 < 7 & 8 > 6\n', 'a.srt').cues[0].html, '5 &lt; 7 &amp; 8 &gt; 6');
check('SRT: таймкод без миллисекунд',
  S.parse('1\n00:00:01 --> 00:00:03\nБез мс\n', 'a.srt').cues[0].end, 3);
check('SRT: точка вместо запятой',
  S.parse('1\n00:00:01.500 --> 00:00:03.000\nТочка\n', 'a.srt').cues[0].start, 1.5);
check('SRT: реплика нулевой длины получает минимальную длительность',
  S.parse('1\n00:00:05,000 --> 00:00:05,000\nМиг\n', 'a.srt').cues[0].end > 5, true);
check('SRT: реплики сортируются по времени',
  S.parse('1\n00:00:09,000 --> 00:00:10,000\nБ\n\n2\n00:00:01,000 --> 00:00:02,000\nА\n', 'a.srt')
    .cues.map(c => c.html), ['А', 'Б']);
check('SRT: пустая реплика пропускается',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nЕсть текст\n', 'a.srt')
    .cues.length, 1);
check('SRT: текст-число не принимается за номер блока',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\n1984\n', 'a.srt').cues[0].html, '1984');
check('Мусор вместо субтитров даёт пустой список',
  S.parse('просто текстовый файл\nбез таймкодов\n', 'a.srt').cues.length, 0);

// ---------- ASS / SSA ----------

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(320,300)}Первая реплика',
  'Dialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\i1}Курсив{\\i0}\\NВторая строка',
  'Comment: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,Комментарий не показываем',
  'Dialogue: 0,0:00:07.00,0:00:09.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}',
  'Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Текст, с запятой',
  'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Реплика A',
  'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Реплика B',
  'Dialogue: 0,0:00:13.00,0:00:14.00,Default,,0,0,0,,Жёсткий\\hпробел'
].join('\n');

{
  const r = S.parse(ASS, 'a.ass');
  check('ASS: формат распознан', r.format, 'ass');
  check('ASS: {\\pos} вырезан', r.cues[0].html, 'Первая реплика');
  check('ASS: {\\i1} → курсив, \\N → перенос', r.cues[1].html, '<i>Курсив</i><br>Вторая строка');
  check('ASS: Comment не попадает в реплики',
    r.cues.filter(c => /Комментарий/.test(c.html)).length, 0);
  check('ASS: векторный рисунок {\\p1} пропущен',
    r.cues.filter(c => /m 0 0/.test(c.html)).length, 0);
  check('ASS: запятая в тексте сохранена', r.cues[2].html, 'Текст, с запятой');
  check('ASS: одинаковое время — реплики склеены', r.cues[3].html, 'Реплика A<br>Реплика B');
  check('ASS: \\h превращается в пробел', r.cues[4].html, 'Жёсткий пробел');
  check('ASS: сотые доли секунды', [r.cues[1].start, r.cues[1].end], [3.5, 6]);
}
check('ASS: порядок полей берётся из строки Format',
  S.parse('[Events]\nFormat: Start, End, Text\nDialogue: 0:00:02.00,0:00:04.00,Текст\n', 'a.ass')
    .cues[0], { start: 2, end: 4, html: 'Текст' });
check('ASS распознаётся и без правильного расширения',
  S.parse(ASS, 'subs.txt').format, 'ass');
check('SRT распознаётся и без правильного расширения',
  S.parse('1\n00:00:01,000 --> 00:00:02,000\nТекст\n', 'subs.txt').format, 'srt');

// ---------- выбор активной реплики (то, что рисует оверлей) ----------

const cues = S.parse(
  '1\n00:00:01,000 --> 00:00:03,000\nПервая\n\n' +
  '2\n00:00:05,000 --> 00:00:08,000\nВторая\n\n' +
  '3\n00:00:06,000 --> 00:00:07,000\nПерекрытие\n', 'a.srt').cues;

check('Показ: до первой реплики пусто', S.activeHtml(cues, 0.5), '');
check('Показ: внутри реплики', S.activeHtml(cues, 2), 'Первая');
check('Показ: конец не включается', S.activeHtml(cues, 3), '');
check('Показ: в паузе между репликами пусто', S.activeHtml(cues, 4), '');
check('Показ: перекрывающиеся реплики вместе', S.activeHtml(cues, 6.5), 'Вторая<br>Перекрытие');
check('Показ: после последней реплики пусто', S.activeHtml(cues, 99), '');
check('Показ: перемотка назад работает так же', S.activeHtml(cues, 2), 'Первая');
check('Показ: список активных реплик', S.findActive(cues, 6.5).map(c => c.html), ['Вторая', 'Перекрытие']);
check('Показ: сдвиг тайминга (video.currentTime - shift)', S.activeHtml(cues, 7 - 5), 'Первая');
check('Показ: пустой список реплик не падает', S.activeHtml([], 5), '');
check('Показ: NaN вместо времени не падает', S.activeHtml(cues, NaN), '');

// ---------- сквозной пайплайн: байты → показ ----------

{
  const raw = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    bytes('1\r\n00:00:02,000 --> 00:00:04,000\r\n<i>Сквозной</i> тест\r\n')
  ]);
  const dec = S.decodeBytes(raw);
  const parsed = S.parse(dec.text, 'pipeline.srt');
  ok('Пайплайн: байты с BOM доходят до готовой разметки',
    dec.encoding === 'utf-8 (BOM)' && parsed.cues.length === 1 &&
    S.activeHtml(parsed.cues, 3) === '<i>Сквозной</i> тест',
    JSON.stringify({ enc: dec.encoding, html: S.activeHtml(parsed.cues, 3) }));
}

// ---------- opensubtitles.com: сборка ссылок и группировка ----------

const O = require(path.join(__dirname, '..', 'extension', 'src', 'opensubs.js'));

check('Ссылка на серию содержит сезон, серию и все языки',
  O.buildEpisodeSearchUrl('1326008', 1, 5),
  'https://www.opensubtitles.com/en/all/search-tvshows/q-osdb:1326008/hearing_impaired-/machine_translated-/trusted_sources-/season-1/episode-5');
check('Идентификатор сериала чистится от мусора',
  O.buildEpisodeSearchUrl('osdb:42', 2, 13).indexOf('q-osdb:42/') !== -1, true);
check('Поиск по названию: пробелы кодируются',
  O.buildTitleSearchUrl('frieren beyond journey').indexOf('q-frieren%2Bbeyond%2Bjourney') !== -1, true);
check('Идентификатор сериала находится в разметке страницы',
  O.extractShowId('<a href="/en/en/search-tvshows/q-osdb:1326008/season-1/episode-">x</a>'), '1326008');
check('Идентификатора нет — возвращается null', O.extractShowId('<div>ничего</div>'), null);

check('Язык по коду называется по-русски', O.langLabel('ru', 'русский язык'), 'русский');
check('Язык без русского названия берётся с сайта', O.langLabel('xx', 'Klingon'), 'Klingon');
check('Нечитаемое название заменяется кодом языка', O.langLabel('bn', '?????'), 'бенгальский');
check('Диалект наследует название языка', O.langLabel('pt-BR', 'Português'), 'португальский (BR)');

check('Относительная ссылка достраивается до полной',
  O.absolute('/en/subtitles/x'), 'https://www.opensubtitles.com/en/subtitles/x');
check('Полная ссылка не трогается',
  O.absolute('https://www.opensubtitles.com/en/subtitles/x'), 'https://www.opensubtitles.com/en/subtitles/x');

{
  const rows = [
    { code: 'ru', name: 'русский язык', label: 'русский', url: 'u1', release: 'r1', downloads: 58 },
    { code: 'en', name: 'English', label: 'английский', url: 'u2', release: 'r2', downloads: 306 },
    { code: 'ru', name: 'русский язык', label: 'русский', url: 'u3', release: 'r3', downloads: 141 }
  ];
  const g = O.groupByLanguage(rows);
  check('Группировка: языки по числу вариантов', g.map(x => x.code + ':' + x.count), ['ru:2', 'en:1']);
  check('Группировка: лучший вариант — самый скачиваемый', g[0].best.url, 'u3');
  check('Группировка: скачивания суммируются', g[0].downloads, 199);
  check('Дедупликация по ссылке и языку',
    O.dedupe(rows.concat(rows)).length, 3);
}

{
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const rar = new Uint8Array([0x52, 0x61, 0x72, 0x21]);
  const html = new Uint8Array(Buffer.from('<!DOCTYPE html><html><body>лимит</body></html>'));
  const srt = new Uint8Array(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nтекст\n'));
  check('Архив zip распознан', O.sniffPayload(zip), 'zip');
  check('Архив rar распознан', O.sniffPayload(rar), 'rar');
  check('Страница сайта вместо файла распознана', O.sniffPayload(html), 'html');
  check('Настоящие субтитры распознаны', O.sniffPayload(srt), 'subtitle');
}


// ---------- распаковка zip с субтитрами ----------

const Z = require(path.join(__dirname, '..', 'extension', 'src', 'subzip.js'));
const zlib = require('zlib');

// Собираем настоящий zip вручную: так тест не зависит от внешних утилит.
function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const raw = Buffer.from(f.data);
    const deflated = f.store ? raw : zlib.deflateRawSync(raw);
    const method = f.store ? 0 : 8;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBytes.length, 26);
    locals.push(lh, Buffer.from(nameBytes), deflated);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, Buffer.from(nameBytes));

    offset += lh.length + nameBytes.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

check('zip распознаётся по сигнатуре', Z.isZip(new Uint8Array([0x50, 0x4b, 3, 4, 0])), true);
check('обычный файл за zip не принимается', Z.isZip(new Uint8Array([1, 2, 3, 4, 5])), false);

{
  const zip = makeZip([
    { name: 'readme.txt', data: 'мусор рядом с субтитрами' },
    { name: 'Frieren.S01E05.srt', data: '1\n00:00:01,000 --> 00:00:03,000\nИз архива\n' }
  ]);
  check('в архиве видно оба файла', Z.listEntries(new Uint8Array(zip)).length, 2);
  const got = await Z.extractSubtitle(zip);
  check('из архива достаётся именно файл субтитров', got.name, 'Frieren.S01E05.srt');
  check('содержимое распаковано верно',
    S.parse(Buffer.from(got.bytes).toString('utf8'), got.name).cues[0].html, 'Из архива');
}
{
  const zip = makeZip([{ name: 'sub.ass', data: '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,,Без сжатия\n', store: true }]);
  const got = await Z.extractSubtitle(zip);
  check('файл, положенный в архив без сжатия, тоже читается',
    S.parse(Buffer.from(got.bytes).toString('utf8'), got.name).cues[0].html, 'Без сжатия');
}
{
  const zip = makeZip([{ name: 'cover.jpg', data: 'не субтитры' }]);
  check('архив без субтитров честно возвращает пустоту', await Z.extractSubtitle(zip), null);
}
check('не-архив не пытается распаковываться',
  await Z.extractSubtitle(new Uint8Array(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nтекст\n'))), null);

// ---------- определение серии по странице ----------

{
  const d1 = O.detectEpisode('https://anidb.app/anime/mushoku-tensei-jobless-reincarnation-3564',
    'Mushoku Tensei: Jobless Reincarnation — Watch Online Free — AniDB');
  check('название вытаскивается из заголовка сайта', d1.title, 'Mushoku Tensei: Jobless Reincarnation');

  const d2 = O.detectEpisode('https://site.tv/watch/frieren/season-1/episode-5', 'Frieren watch online');
  check('сезон и серия из адреса', [d2.season, d2.episode], [1, 5]);

  const d3 = O.detectEpisode('https://x.org/v', 'Bleach S02E13 1080p');
  check('формат S..E.. в заголовке', [d3.title, d3.season, d3.episode], ['Bleach', 2, 13]);

  const d4 = O.detectEpisode('https://x.org/show?ep=12', 'Naruto Episode 12 online free HD');
  check('номер серии из параметра ссылки', d4.episode, 12);
  check('служебные слова из названия вычищены', d4.title, 'Naruto');

  const d5 = O.detectEpisode('https://x.org/anime/one-punch-man-3931', '');
  check('название собирается из адреса, если заголовка нет', d5.title, 'one punch man');

  const d6 = O.detectEpisode('https://x.org/', 'Просто сайт');
  check('без признаков серии номер не выдумывается', [d6.season, d6.episode], [null, null]);
}

// ---------- osnet: подбор названия и ссылки на файл ----------

globalThis.OpenSubs = O;
const N = require(path.join(__dirname, '..', 'extension', 'src', 'osnet.js'));

check('Варианты названия: сначала полное, потом до двоеточия',
  N.titleVariants('Mushoku Tensei: Jobless Reincarnation').slice(0, 3),
  ['Mushoku Tensei: Jobless Reincarnation', 'Mushoku Tensei', 'Jobless Reincarnation']);
check('Варианты названия: номер сезона отбрасывается',
  N.titleVariants('Overlord 2nd Season').indexOf('Overlord') !== -1, true);
check('Короткое название не размножается', N.titleVariants('Bleach'), ['Bleach']);

check('Точное совпадение названия получает максимум',
  N.scoreShow({ title: 'Frieren Beyond Journeys End' }, 'frieren beyond journeys end'), 100);
check('Совпадение по началу названия ценится высоко',
  N.scoreShow({ title: 'Mushoku Tensei: Jobless Reincarnation' }, 'Mushoku Tensei') >= 80, true);
check('Чужой сериал получает мало очков',
  N.scoreShow({ title: 'Naruto Shippuden' }, 'Mushoku Tensei') < 20, true);

check('Сериалы идут раньше фильмов, точное название — первым',
  N.rankShows([
    { title: 'Mushoku Tensei', isSeries: false, url: 'a' },
    { title: 'Mushoku Tensei II: Jobless Reincarnation', isSeries: true, url: 'b' },
    { title: 'Mushoku Tensei: Jobless Reincarnation', isSeries: true, url: 'c' }
  ], 'Mushoku Tensei: Jobless Reincarnation', true).map(s => s.url),
  ['c', 'b', 'a']);

function fakeDoc(map) {
  return {
    querySelector: function (sel) {
      const href = map[sel];
      if (!href) return null;
      return { getAttribute: function (a) { return a === 'href' ? href : null; } };
    }
  };
}
check('Ссылка на файл берётся из готового атрибута',
  N.downloadHref(fakeDoc({ 'a[download][href]': '/en/subtitleserve/sub/777' }), 'x').url,
  'https://www.opensubtitles.com/en/subtitleserve/sub/777');
check('Без ссылки адрес файла собирается из номера субтитров',
  N.downloadHref(fakeDoc({}), 'https://www.opensubtitles.com/en/subtitles/12345/frieren-ru').url,
  'https://www.opensubtitles.com/en/subtitleserve/sub/12345');
check('Совсем без зацепок ссылки нет', N.downloadHref(fakeDoc({}), '/en/tvshows/x'), null);

check('Готовый ответ содержит языки и счётчик',
  (function () {
    const r = N.pack([
      { code: 'ru', name: 'русский язык', label: 'русский', url: 'u1', release: 'r1', downloads: 5 },
      { code: 'ru', name: 'русский язык', label: 'русский', url: 'u2', release: 'r2', downloads: 50 },
      { code: 'en', name: 'English', label: 'английский', url: 'u3', release: 'r3', downloads: 9 }
    ], 'url');
    return { total: r.total, langs: r.languages.map(l => l.label + ':' + l.count), best: r.languages[0].best.url };
  })(),
  { total: 3, langs: ['русский:2', 'английский:1'], best: 'u2' });

// ---------- osnet: отличаем «сайт не пустил» от «ничего не нашлось» ----------

async function grabError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

{
  const realFetch = globalThis.fetch;

  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
  const forbidden = await grabError(() => N.fetchDoc('https://www.opensubtitles.com/en'));
  ok('Ответ 403 помечен как сбой транспорта', !!(forbidden && forbidden.transportFailed),
    forbidden && forbidden.message);
  ok('В тексте ошибки видно код ответа', /403/.test((forbidden && forbidden.message) || ''));

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const dead = await grabError(() => N.fetchDoc('https://www.opensubtitles.com/en'));
  ok('Оборванный запрос помечен как сбой транспорта', !!(dead && dead.transportFailed),
    dead && dead.message);

  globalThis.fetch = async () => ({ ok: false, status: 429 });
  const tooMany = await grabError(() => N.fetchBytes('https://www.opensubtitles.com/x', 'a.srt'));
  ok('Отказ при скачивании файла тоже помечен как сбой транспорта',
    !!(tooMany && tooMany.transportFailed), tooMany && tooMany.message);

  globalThis.fetch = realFetch;
}

// ---------- AnimeTosho: подбор раздачи и разбор вложений ----------

const T = require(path.join(__dirname, '..', 'extension', 'src', 'tosho.js'));

check('Запрос к серии идёт с ведущим нулём',
  T.queriesFor('Mushoku Tensei', 1, 3)[0], 'Mushoku Tensei 03');
check('Для второго сезона пробуется и запись S02E03',
  T.queriesFor('Mushoku Tensei', 2, 3).some(q => /S02E03/.test(q)), true);
check('Без номера серии остаётся одно название',
  T.queriesFor('Frieren', null, null), ['Frieren']);

check('Номер серии из базы AniDB берётся по большинству раздач',
  T.dominantEid([{ anidb_eid: 5 }, { anidb_eid: 7 }, { anidb_eid: 7 }, {}]), '7');
check('Если номеров нет — честный null', T.dominantEid([{}, { title: 'x' }]), null);

check('Раздача известной группы с дорожками ценится выше',
  T.rankEntries([
    { id: 1, title: 'Random.Encode.S01E03.mp4', torrent_downloaded_count: 100 },
    { id: 2, title: '[Erai-raws] Show - 03 [1080p][Multiple Subtitle].mkv', torrent_downloaded_count: 10 }
  ]).map(e => e.id),
  [2, 1]);

function fakeLink(label, href) {
  return {
    textContent: label,
    getAttribute: function (a) { return a === 'href' ? href : null; }
  };
}
function fakeToshoDoc(links) {
  return { querySelectorAll: function () { return links; } };
}
{
  const doc = fakeToshoDoc([
    fakeLink('English [eng, ASS]', '/storage/attach/001e56e0/Show%20-%2003_track3.eng.ass.xz'),
    fakeLink('Russian [rus, SRT]', 'https://animetosho.org/storage/attach/001e56e1/Show%20-%2003_track4.rus.srt.xz'),
    fakeLink('Font [ttf]', '/storage/attach/001e56e9/font.ttf.xz')
  ]);
  const att = T.parseAttachments(doc, '[Erai-raws] Show - 03');
  check('Вложения: шрифты и прочий мусор отсеиваются', att.length, 2);
  check('Вложения: язык распознан по метке', att.map(a => a.code), ['en', 'ru']);
  check('Вложения: имя файла без .xz', att[0].name, 'Show - 03_track3.eng.ass');
  check('Вложения: относительная ссылка достроена',
    att[0].url, 'https://animetosho.org/storage/attach/001e56e0/Show%20-%2003_track3.eng.ass.xz');
  check('Вложения: абсолютная ссылка не портится',
    att[1].url.indexOf('https://animetosho.org/storage/attach/001e56e1/') === 0, true);
  check('Вложения: помнят, из какой раздачи взяты', att[0].release, '[Erai-raws] Show - 03');
}

check('Ссылки AnimeTosho узнаются', T.handles('https://animetosho.org/storage/attach/1/x.ass.xz'), true);
check('Ссылки с поддомена тоже узнаются',
  T.handles('https://storage.animetosho.org/attach/1/x.ass.xz'), true);
check('Чужие ссылки не перехватываются',
  T.handles('https://www.opensubtitles.com/en/subtitles/123/x'), false);

// ---------- распаковка .xz (субтитры с AnimeTosho) ----------

const XZ = require(path.join(__dirname, '..', 'extension', 'src', 'unxz.js'));

{
  const fs = require('fs');
  const read = f => new Uint8Array(fs.readFileSync(path.join(__dirname, f)));

  ok('Файл .xz узнаётся по подписи', XZ.isXz(read('xz-sample.ass.xz')));
  ok('Обычный текст за .xz не принимается', !XZ.isXz(Buffer.from('1\n00:00:01,000 --> ')));

  const ass = Buffer.from(XZ.decompress(read('xz-sample.ass.xz')));
  const wantAss = fs.readFileSync(path.join(__dirname, '..', 'examples', 'пример.ass'));
  ok('Распакованный .ass совпадает с исходником байт в байт', ass.equals(wantAss),
    'получено ' + ass.length + ', ожидалось ' + wantAss.length);

  // многоблочный файл: одна строка повторяется 900 раз
  const line = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Line of dialogue\n';
  const multi = Buffer.from(XZ.decompress(read('xz-multi.xz')));
  ok('Многоблочный .xz распаковывается целиком', multi.equals(Buffer.from(line.repeat(900))),
    'получено ' + multi.length);

  // плохо сжимаемые данные — проверяем и куски, которые лежат как есть
  let x = 7;
  const noise = Buffer.alloc(20000);
  for (let i = 0; i < noise.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    noise[i] = (x >>> 24) & 0xFF;
  }
  const got = Buffer.from(XZ.decompress(read('xz-noise.xz')));
  ok('Несжимаемые данные распаковываются точно', got.equals(noise),
    'получено ' + got.length + ', ожидалось ' + noise.length);

  let broke = null;
  try { XZ.decompress(Buffer.from('это просто текст, а не архив')); }
  catch (e) { broke = e.message; }
  ok('Не-архив отвергается с понятной ошибкой', /не файл \.xz/.test(broke || ''), broke);
}

// ---------- автоподгонка субтитров по звуку ----------

const SS = require(path.join(__dirname, '..', 'extension', 'src', 'subsync.js'));

// Простой генератор псевдослучайных чисел: тест должен быть повторяемым.
function rng(seed) {
  let x = seed >>> 0;
  return function () {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

// Делаем «серию»: реплики в файле и запись громкости с известным сдвигом.
function fakeEpisode(opts) {
  const o = Object.assign({ shift: 0, seconds: 120, seed: 7, noise: 0.02, music: 0 }, opts || {});
  const rand = rng(o.seed);
  const cues = [];
  let t = 3;
  while (t < o.seconds - 6) {
    const len = 1.1 + rand() * 1.4;
    cues.push({ start: t, end: t + len, html: 'x' });
    t += len + 0.35 + rand() * 1.2;
  }
  const samples = [];
  for (let time = 0; time <= o.seconds; time += 0.04) {
    const fileTime = time - o.shift;
    const speaking = cues.some(c => fileTime >= c.start && fileTime <= c.end);
    let level = 0.05 + rand() * o.noise;
    if (speaking) level += 0.30 + rand() * 0.12;
    // фоновая музыка: медленная волна, которая мешает простому порогу
    if (o.music) level += o.music * (0.5 + 0.5 * Math.sin(time / 7));
    samples.push({ time: time, level: level });
  }
  return { cues, samples };
}

{
  const env = SS.cueEnvelope([{ start: 1, end: 2 }, { start: 5, end: 5.5 }], 0, 0.5, 12);
  check('Дорожка реплик отмечает занятые отрезки',
    Array.from(env).join(''), '001110000011');
}

{
  const ep = fakeEpisode({ shift: 2.6 });
  const res = SS.estimateShift({ samples: ep.samples, cues: ep.cues });
  ok('Сдвиг вперёд найден', res.ok && Math.abs(res.shift - 2.6) <= 0.12, JSON.stringify(res));
}

{
  const ep = fakeEpisode({ shift: -4.32, seed: 21 });
  const res = SS.estimateShift({ samples: ep.samples, cues: ep.cues });
  ok('Сдвиг назад найден', res.ok && Math.abs(res.shift + 4.32) <= 0.12, JSON.stringify(res));
}

{
  const ep = fakeEpisode({ shift: 1.8, seed: 33, music: 0.12, noise: 0.06 });
  const res = SS.estimateShift({ samples: ep.samples, cues: ep.cues });
  ok('Музыка и шум не сбивают подгонку', res.ok && Math.abs(res.shift - 1.8) <= 0.16, JSON.stringify(res));
}

{
  const ep = fakeEpisode({ shift: 0, seed: 5 });
  const rand = rng(99);
  const noise = ep.samples.map(s => ({ time: s.time, level: 0.05 + rand() * 0.4 }));
  const res = SS.estimateShift({ samples: noise, cues: ep.cues });
  ok('Из чистого шума сдвиг не выдумывается', !res.ok, JSON.stringify(res));
}

{
  const ep = fakeEpisode({ shift: 3, seconds: 20 });
  const res = SS.estimateShift({ samples: ep.samples.slice(0, 120), cues: ep.cues });
  ok('Слишком короткая запись честно отклоняется', !res.ok, JSON.stringify(res));
  check('Причина отказа названа по-человечески', typeof res.reason === 'string' && res.reason.length > 3, true);
}

{
  const ep = fakeEpisode({ shift: 2 });
  const res = SS.estimateShift({ samples: ep.samples, cues: ep.cues.slice(0, 3) });
  ok('Без достаточного числа реплик подгонка не запускается', !res.ok, JSON.stringify(res));
}

// ---------- манифест расширения ----------

{
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  check('Манифест: третья версия', m.manifest_version, 3);
  check('Манифест: разрешения минимальны', m.permissions.sort(), ['activeTab', 'scripting', 'storage']);
  // Права должны оставаться узкими: только конкретные сайты субтитров,
  // никаких «любых страниц» сверх content script.
  const hosts = m.host_permissions || [];
  ok('Манифест: доступ запрошен только к сайтам субтитров',
    hosts.length > 0 && hosts.length <= 3 &&
    hosts.every(h => /^https:\/\/[^*]/.test(h) || /^https:\/\/\*\.[a-z0-9-]+\.[a-z]{2,}\/\*$/.test(h)),
    JSON.stringify(hosts));
  ok('Манифест: сайт субтитров opensubtitles разрешён',
    hosts.some(h => h.indexOf('opensubtitles.com') !== -1), JSON.stringify(hosts));
  check('Манифест: content script во всех фреймах', m.content_scripts[0].all_frames, true);
  ok('Манифест: все файлы скриптов на месте',
    m.content_scripts[0].js.every(f => fs.existsSync(path.join(__dirname, '..', 'extension', f))));
  ok('Манифест: иконки на месте',
    Object.values(m.icons).every(f => fs.existsSync(path.join(__dirname, '..', 'extension', f))));
  ok('Манифест: попап на месте',
    fs.existsSync(path.join(__dirname, '..', 'extension', m.action.default_popup)));
  const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'popup.html'), 'utf8');
  ok('Попап подключает сетевой модуль поиска', popupHtml.indexOf('osnet.js') !== -1);
  ok('Попап подключает AnimeTosho и распаковку .xz',
    popupHtml.indexOf('tosho.js') !== -1 && popupHtml.indexOf('unxz.js') !== -1);
  ok('Файл сетевого модуля на месте',
    fs.existsSync(path.join(__dirname, '..', 'extension', 'src', 'osnet.js')));
}

console.log('\n' + passed + '/' + (passed + failures.length) + ' проверок пройдено');
if (failures.length) {
  console.log('Провалились:\n - ' + failures.join('\n - '));
  process.exit(1);
}
})();
