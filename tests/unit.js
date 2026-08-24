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

// ---------- манифест расширения ----------

{
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  check('Манифест: третья версия', m.manifest_version, 3);
  check('Манифест: разрешения минимальны', m.permissions.sort(), ['activeTab', 'scripting', 'storage']);
  check('Манифест: нет host_permissions сверх content_scripts', m.host_permissions, undefined);
  check('Манифест: content script во всех фреймах', m.content_scripts[0].all_frames, true);
  ok('Манифест: все файлы скриптов на месте',
    m.content_scripts[0].js.every(f => fs.existsSync(path.join(__dirname, '..', 'extension', f))));
  ok('Манифест: иконки на месте',
    Object.values(m.icons).every(f => fs.existsSync(path.join(__dirname, '..', 'extension', f))));
  ok('Манифест: попап на месте',
    fs.existsSync(path.join(__dirname, '..', 'extension', m.action.default_popup)));
}

console.log('\n' + passed + '/' + (passed + failures.length) + ' проверок пройдено');
if (failures.length) {
  console.log('Провалились:\n - ' + failures.join('\n - '));
  process.exit(1);
}
