const { chromium } = require('playwright');
const crypto = require('crypto');
const path = require('path');
const fsmod = require('fs');

const EXT = path.join(__dirname, '..', 'extension');
const FIX = (name) => path.join(__dirname, name);
const BASE = 'http://127.0.0.1:8123';
const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info: info === undefined ? '' : String(info) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (info !== undefined && info !== '' ? '  → ' + info : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function unpackedId(dir) {
  const h = crypto.createHash('sha256').update(Buffer.from(dir, 'utf8')).digest('hex').slice(0, 32);
  return h.split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function overlayText(page) {
  return page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    if (!h || !h.shadowRoot) return null;
    return h.shadowRoot.querySelector('.text').innerHTML;
  });
}

(async () => {
  const userDataDir = '/tmp/pwprofile-' + Date.now();
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox'
    ]
  });

  const errors = [];
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => {
    // прерванные запросы к самому видео — следствие пересоздания <video> в тесте
    if (/favicon|video\.webm/.test(r.url())) return;
    errors.push('reqfail: ' + r.url());
  });
  page.on('response', r => { if (r.status() === 404 && !/favicon/.test(r.url())) errors.push('404: ' + r.url()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/page.html');
  await page.waitForSelector('video', { timeout: 5000 });
  await sleep(1200);

  const extId = unpackedId(EXT);
  const popupUrl = `chrome-extension://${extId}/src/popup.html`;
  const popup = await ctx.newPage();
  const popupErrors = [];
  popup.on('console', m => { if (m.type() === 'error') popupErrors.push(m.text()); });
  popup.on('pageerror', e => popupErrors.push(e.message));
  let popupOk = true;
  try { await popup.goto(popupUrl, { timeout: 8000 }); } catch (e) { popupOk = false; console.log('popup goto failed: ' + e.message); }
  check('Расширение загружено, попап открывается', popupOk, popupUrl);
  if (!popupOk) { await ctx.close(); process.exit(1); }

  await sleep(1200);
  const status1 = await popup.textContent('#status');
  check('Попап видит видео на странице', /Найдено видео/.test(status1 || ''), status1);

  // ---- панель поиска на opensubtitles.com в попапе ----
  await popup.click('#osToggle');
  await sleep(300);
  const osPanelOpen = await popup.evaluate(() => !document.getElementById('osPanel').classList.contains('hidden'));
  check('Попап: панель поиска субтитров разворачивается', osPanelOpen);
  await popup.click('#osSearch');
  await sleep(400);
  const osValidation = await popup.textContent('#osStatus');
  check('Попап: поиск без названия просит ввести название',
    /Введите название/.test(osValidation || ''), osValidation);
  await popup.click('#osToggle');
  await sleep(200);

  // ---- SRT через попап (реальный путь пользователя) ----
  await popup.setInputFiles('#fileInput', FIX('test.srt'));
  await sleep(900);
  const info = await popup.textContent('#fileInfo');
  check('SRT загружен через попап', /6 реплик/.test(info || ''), info);

  await page.bringToFront();
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
  await sleep(400);
  let t = await overlayText(page);
  check('SRT: реплика 1 на 2-й секунде', t === 'First line of the test.', t);

  await page.evaluate(() => { document.querySelector('video').currentTime = 4; });
  await sleep(300);
  t = await overlayText(page);
  check('SRT: курсив и перенос строки', t === '<i>Italic second</i> line<br>with a break', t);

  await page.evaluate(() => { document.querySelector('video').currentTime = 6.5; });
  await sleep(300);
  t = await overlayText(page);
  check('SRT: между репликами пусто', t === '', JSON.stringify(t));

  // перемотка + пауза
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 13.5; v.pause(); });
  await sleep(400);
  t = await overlayText(page);
  check('SRT: перемотка на паузе показывает нужную реплику', t === 'Fifth cue here', t);

  // воспроизведение и синхронность
  await page.bringToFront();
  const playErr = await page.evaluate(async () => {
    const v = document.querySelector('video');
    v.currentTime = 19.5;
    try { await v.play(); return null; } catch (e) { return e.message; }
  });
  await sleep(1600);
  const during = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const v = document.querySelector('video');
    return { text: h.shadowRoot.querySelector('.text').textContent, time: v.currentTime, paused: v.paused };
  });
  check('SRT: синхронно во время воспроизведения', during.text === 'Sixth and last cue' && during.time > 20,
    JSON.stringify(during) + (playErr ? ' play error: ' + playErr : ''));
  await page.evaluate(() => document.querySelector('video').pause());

  // ---- геометрия и клики ----
  const geom = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const v = document.querySelector('video');
    const hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
    const cs = getComputedStyle(h);
    const el = document.elementFromPoint(vr.left + vr.width / 2, vr.top + vr.height - 20);
    return {
      dx: Math.abs(hr.left - vr.left), dy: Math.abs(hr.top - vr.top),
      dw: Math.abs(hr.width - vr.width), dh: Math.abs(hr.height - vr.height),
      pe: cs.pointerEvents, z: cs.zIndex, hit: el ? el.tagName : null
    };
  });
  check('Оверлей совпадает с видео по геометрии', geom.dx < 1.5 && geom.dy < 1.5 && geom.dw < 1.5 && geom.dh < 1.5, JSON.stringify(geom));
  check('Оверлей не перехватывает клики', geom.pe === 'none' && geom.hit === 'VIDEO', JSON.stringify(geom));
  check('Максимальный z-index', geom.z === '2147483647', geom.z);

  // ---- сдвиг тайминга ----
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
  await popup.bringToFront();
  await popup.click('[data-shift="5"]');
  await sleep(300);
  await page.bringToFront();
  await sleep(600);
  const shiftLabel = await popup.textContent('#shiftValue');
  t = await overlayText(page);
  check('Сдвиг +5 с: реплика ушла', t === '' && /\+5/.test(shiftLabel || ''), JSON.stringify({ t, shiftLabel }));
  await page.bringToFront();
  await page.evaluate(() => { document.querySelector('video').currentTime = 7; });
  await sleep(400);
  t = await overlayText(page);
  check('Сдвиг +5 с: реплика показана со сдвигом', t === 'First line of the test.', t);

  // сдвиг не сбрасывается при паузе/перемотке
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 1; v.play(); });
  await sleep(500);
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 7.5; });
  await sleep(500);
  t = await overlayText(page);
  check('Сдвиг переживает паузу и перемотку', t === 'First line of the test.', t);

  // горячие клавиши на странице
  await page.bringToFront();
  await page.click('h3');
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyG');
  await sleep(400);
  await popup.bringToFront();
  await sleep(1200);
  const shiftAfterKeys = await popup.textContent('#shiftValue');
  check('Горячие клавиши G/H меняют сдвиг (−0,5 ×2 от +5)', /\+4,00/.test(shiftAfterKeys || ''), shiftAfterKeys);
  // сброс
  await popup.bringToFront();
  await popup.click('#resetShift');
  await sleep(400);

  // ---- пересоздание видео (смена серии) ----
  await page.bringToFront();
  await page.click('#next');
  await sleep(1500);
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
  await sleep(600);
  t = await overlayText(page);
  const attached = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const v = document.querySelector('video');
    const hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
    return Math.abs(hr.top - vr.top) < 1.5 && hr.width > 100;
  });
  check('Оверлей переезжает на пересозданное видео', t === 'First line of the test.' && attached, JSON.stringify({ t, attached }));

  // ---- полноэкранный режим (сайт разворачивает сам <video>) ----
  await page.click('#fs');
  await sleep(1400);
  const fsInfo = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const fse = document.fullscreenElement;
    let topLayer = false;
    try { topLayer = h.matches(':popover-open'); } catch (e) {}
    return {
      fsTag: fse ? fse.tagName : null,
      topLayer: topLayer,
      inside: !!(fse && fse.contains(h)),
      text: h && h.shadowRoot ? h.shadowRoot.querySelector('.text').textContent : null,
      w: h ? h.getBoundingClientRect().width : 0,
      vw: document.querySelector('video').getBoundingClientRect().width
    };
  });
  await page.screenshot({ path: FIX('shot-fullscreen.png') });
  check('Фуллскрин: субтитры видны поверх видео',
    (fsInfo.topLayer || fsInfo.inside) && fsInfo.text === 'First line of the test.' && Math.abs(fsInfo.w - fsInfo.vw) < 2,
    JSON.stringify(fsInfo));

  await page.evaluate(() => document.exitFullscreen && document.exitFullscreen());
  await sleep(1200);
  const afterFs = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const v = document.querySelector('video');
    const hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
    let open = false; try { open = h.matches(':popover-open'); } catch (e) {}
    return { text: h.shadowRoot.querySelector('.text').textContent, stillPopover: open,
             ok: Math.abs(hr.width - vr.width) < 2 && Math.abs(hr.top - vr.top) < 2 };
  });
  check('Выход из фуллскрина: субтитры продолжают работать',
    afterFs.ok && afterFs.text === 'First line of the test.' && !afterFs.stillPopover, JSON.stringify(afterFs));

  // ---- фуллскрин контейнера (как у большинства плееров) ----
  await page.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = 'fsbox';
    btn.textContent = 'FS контейнера';
    btn.addEventListener('click', () => document.getElementById('player').requestFullscreen());
    document.body.appendChild(btn);
  });
  await page.click('#fsbox');
  await sleep(1400);
  const fsBox = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    const fse = document.fullscreenElement;
    let open = false; try { open = h.matches(':popover-open'); } catch (e) {}
    const hr = h.getBoundingClientRect(), vr = document.querySelector('video').getBoundingClientRect();
    return { fsTag: fse ? fse.id || fse.tagName : null, open: open, inside: !!(fse && fse.contains(h)),
             text: h.shadowRoot.querySelector('.text').textContent,
             fit: Math.abs(hr.width - vr.width) < 2 && Math.abs(hr.height - vr.height) < 2 };
  });
  await page.screenshot({ path: FIX('shot-fullscreen-box.png') });
  check('Фуллскрин контейнера плеера: субтитры на месте',
    (fsBox.open || fsBox.inside) && fsBox.fit && fsBox.text === 'First line of the test.', JSON.stringify(fsBox));
  await page.evaluate(() => document.exitFullscreen && document.exitFullscreen());
  await sleep(1000);

  // ---- ASS ----
  await popup.bringToFront();
  await popup.setInputFiles('#fileInput', FIX('test.ass'));
  await sleep(900);
  const assInfo = await popup.textContent('#fileInfo');
  check('ASS загружен', /ASS/.test(assInfo || ''), assInfo);
  await page.bringToFront();
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
  await sleep(500);
  t = await overlayText(page);
  check('ASS: тег {\\pos} вырезан', t === 'Первая ASS-реплика', t);
  await page.evaluate(() => { document.querySelector('video').currentTime = 4; });
  await sleep(300);
  t = await overlayText(page);
  check('ASS: {\\i1} → курсив, \\N → перенос', t === '<i>Курсив</i><br>Вторая строка', t);
  await page.evaluate(() => { document.querySelector('video').currentTime = 8; });
  await sleep(300);
  t = await overlayText(page);
  check('ASS: рисунок {\\p1} пропущен, запятая в тексте сохранена', t === 'Текст, с запятой и тегами', t);
  await page.evaluate(() => { document.querySelector('video').currentTime = 11; });
  await sleep(300);
  t = await overlayText(page);
  check('ASS: реплики с одинаковым временем показаны вместе', t === 'Реплика A<br>Реплика B одновременно', t);

  // ---- windows-1251 ----
  await popup.bringToFront();
  await popup.setInputFiles('#fileInput', FIX('test-1251.srt'));
  await sleep(900);
  const encInfo = await popup.textContent('#fileInfo');
  await page.bringToFront();
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
  await sleep(400);
  t = await overlayText(page);
  check('windows-1251 читается без кракозябр', t === 'Привет, это тест кодировки' && /windows-1251/.test(encInfo || ''), JSON.stringify({ t, encInfo }));
  await page.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await sleep(300);
  t = await overlayText(page);
  check('windows-1251: буквы Ё, щ, тире', t === 'Ёжик, съел щуку — ага', t);

  // BOM
  await popup.bringToFront();
  await popup.setInputFiles('#fileInput', FIX('test-bom.srt'));
  await sleep(800);
  const bomInfo = await popup.textContent('#fileInfo');
  check('UTF-8 с BOM распознан', /BOM/.test(bomInfo || ''), bomInfo);

  // ---- удаление субтитров ----
  await popup.click('#clearBtn');
  await sleep(600);
  const gone = await page.evaluate(() => !document.querySelector('[data-sub-overlay]'));
  check('Кнопка «Убрать субтитры» удаляет оверлей', gone);

  // ---- drag & drop файла на страницу ----
  await page.bringToFront();
  await page.evaluate(() => {
    const srt = '1\n00:00:01,000 --> 00:00:30,000\nDropped subtitle line\n';
    const dt = new DataTransfer();
    dt.items.add(new File([srt], 'dropped.srt', { type: 'text/plain' }));
    const v = document.querySelector('video');
    const r = v.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    v.dispatchEvent(new DragEvent('dragover', opts));
    v.dispatchEvent(new DragEvent('drop', opts));
  });
  await sleep(800);
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; });
  await sleep(500);
  t = await overlayText(page);
  check('Drag & drop файла на видео работает', t === 'Dropped subtitle line', t);

  // ---- файл с кириллическим именем ----
  await page.evaluate(() => {
    const srt = '1\n00:00:01,000 --> 00:00:30,000\nРусское имя файла\n';
    const dt = new DataTransfer();
    dt.items.add(new File([srt], 'Наруто — 01 [рус].srt', { type: 'text/plain' }));
    const v = document.querySelector('video');
    const r = v.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 10 };
    v.dispatchEvent(new DragEvent('dragover', opts));
    v.dispatchEvent(new DragEvent('drop', opts));
  });
  await sleep(800);
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; });
  await sleep(500);
  t = await overlayText(page);
  check('Файл с кириллицей в имени загружается', t === 'Русское имя файла', t);

  // возвращаем предыдущий файл для последующих проверок памяти
  await page.evaluate(() => {
    const srt = '1\n00:00:01,000 --> 00:00:30,000\nDropped subtitle line\n';
    const dt = new DataTransfer();
    dt.items.add(new File([srt], 'dropped.srt', { type: 'text/plain' }));
    const v = document.querySelector('video');
    const r = v.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 10 };
    v.dispatchEvent(new DragEvent('dragover', opts));
    v.dispatchEvent(new DragEvent('drop', opts));
  });
  await sleep(700);

  // ---- настройки применяются сразу ----
  const before = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    return getComputedStyle(h.shadowRoot.querySelector('.text')).fontSize;
  });
  await popup.bringToFront();
  await popup.evaluate(() => {
    const r = document.getElementById('fontSize');
    r.value = '8';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(900);
  await page.bringToFront();
  await sleep(400);
  const after = await page.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    return getComputedStyle(h.shadowRoot.querySelector('.text')).fontSize;
  });
  check('Настройка размера шрифта применяется сразу', parseFloat(after) > parseFloat(before) * 1.5,
    before + ' → ' + after);
  await popup.bringToFront();
  await popup.evaluate(() => {
    const r = document.getElementById('fontSize');
    r.value = '4.2';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);

  // ---- запоминание субтитров для сайта (перезагрузка страницы) ----
  await page.bringToFront();
  await page.reload();
  await page.waitForSelector('video', { timeout: 5000 });
  await sleep(2000);
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; });
  await sleep(800);
  t = await overlayText(page);
  check('После перезагрузки страницы субтитры восстановлены', t === 'Dropped subtitle line', t);

  // ---- видео внутри Shadow DOM ----
  const sdPage = await ctx.newPage();
  await sdPage.goto(BASE + '/shadow.html');
  await sdPage.waitForTimeout(2500);
  await sdPage.evaluate(() => {
    const sr = document.getElementById('holder').shadowRoot;
    const v = sr.querySelector('video');
    const srt = '1\n00:00:01,000 --> 00:00:30,000\nShadow DOM subtitle\n';
    const dt = new DataTransfer();
    dt.items.add(new File([srt], 'shadow.srt', { type: 'text/plain' }));
    const r = v.getBoundingClientRect();
    const opts = { bubbles: true, composed: true, cancelable: true, dataTransfer: dt,
                   clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    v.dispatchEvent(new DragEvent('dragover', opts));
    v.dispatchEvent(new DragEvent('drop', opts));
    v.pause(); v.currentTime = 5;
  });
  await sdPage.waitForTimeout(900);
  const sdRes = await sdPage.evaluate(() => {
    const h = document.querySelector('[data-sub-overlay]');
    if (!h) return { found: false };
    const v = document.getElementById('holder').shadowRoot.querySelector('video');
    const hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
    return { found: true, text: h.shadowRoot.querySelector('.text').textContent,
             fit: Math.abs(hr.width - vr.width) < 2 && Math.abs(hr.top - vr.top) < 2 };
  });
  check('Видео внутри Shadow DOM находится, оверлей встаёт по нему',
    sdRes.found && sdRes.fit && sdRes.text === 'Shadow DOM subtitle', JSON.stringify(sdRes));
  await sdPage.close();

  // ---- страница без видео ----
  const blank = await ctx.newPage();
  const blankErrors = [];
  blank.on('console', m => { if (m.type() === 'error') blankErrors.push(m.text()); });
  blank.on('pageerror', e => blankErrors.push(e.message));
  await blank.goto(BASE + '/novideo.html');
  await sleep(1500);
  const passive = await blank.evaluate(() => document.querySelectorAll('[data-sub-overlay]').length);
  check('На странице без видео ничего не рисуется и нет ошибок', passive === 0 && blankErrors.length === 0, JSON.stringify(blankErrors));

  const realErrors = errors.filter(e => !/favicon/i.test(e) && !/status of 404/.test(e));
  // ---- плеер в чужом (cross-origin) фрейме ----
  await page.close();
  await popup.close();
  await blank.close();
  const fpage = await ctx.newPage();
  const fErrors = [];
  fpage.on('pageerror', e => fErrors.push(e.message));
  await fpage.goto(BASE + '/iframe.html');
  await sleep(3000);
  const fpopup = await ctx.newPage();
  await fpopup.goto(popupUrl);
  await sleep(1600);
  const fStatus = await fpopup.textContent('#status');
  check('Попап находит видео во вложенном фрейме', /Найдено видео: 1/.test(fStatus || '') && /во фрейме/.test(fStatus || ''), fStatus);

  await fpopup.setInputFiles('#fileInput', FIX('test.srt'));
  await sleep(1400);
  const fInfo = await fpopup.textContent('#fileInfo');
  check('Субтитры загружаются в фрейм через попап', /6 реплик/.test(fInfo || ''), fInfo);

  await fpage.bringToFront();
  const frameText = await (async () => {
    const fr = fpage.frames().find(f => /localhost:8123\/page\.html/.test(f.url()));
    if (!fr) return 'нет фрейма';
    await fr.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2; });
    await sleep(600);
    return fr.evaluate(() => {
      const h = document.querySelector('[data-sub-overlay]');
      if (!h) return 'нет оверлея';
      const v = document.querySelector('video');
      const hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
      const fit = Math.abs(hr.width - vr.width) < 2 && Math.abs(hr.top - vr.top) < 2;
      return h.shadowRoot.querySelector('.text').textContent + (fit ? ' [геометрия ок]' : ' [геометрия сбита]');
    });
  })();
  check('Оверлей во фрейме показывает субтитры по месту видео',
    frameText === 'First line of the test. [геометрия ок]', frameText);

  // горячая клавиша нажата в верхнем документе — сдвиг должен уехать во фрейм
  await fpage.click('h3');
  await fpage.keyboard.press('KeyH');
  await sleep(700);
  await fpopup.bringToFront();
  await sleep(1200);
  const fShift = await fpopup.textContent('#shiftValue');
  check('Горячая клавиша из верхнего документа доходит до фрейма', /\+0,50/.test(fShift || ''), fShift);
  check('Нет ошибок на странице с фреймом', fErrors.length === 0, fErrors.join(' | '));

  // ---- разбор таблицы результатов opensubtitles.com ----
  const osPage = await ctx.newPage();
  const osErrors = [];
  osPage.on('pageerror', e => osErrors.push(e.message));
  await osPage.goto(BASE + '/os-fixture.html');
  await osPage.addScriptTag({ path: path.join(__dirname, '..', 'extension', 'src', 'opensubs.js') });
  const osFirstPage = await osPage.evaluate(() => ({
    rows: OpenSubs.parseResults(document).map(r => r.code + ':' + r.downloads),
    total: OpenSubs.totalEntries(document),
    hasNext: !!OpenSubs.nextPageButton(document)
  }));
  check('OpenSubtitles: строки первой страницы разобраны',
    osFirstPage.rows, ['en:306', 'ru:58', 'ja:12']);
  check('OpenSubtitles: общее число результатов прочитано', osFirstPage.total, 5);
  check('OpenSubtitles: кнопка следующей страницы найдена', osFirstPage.hasNext, true);

  const osAll = await osPage.evaluate(async () => {
    const res = await OpenSubs.collectPages(document, { sleep: ms => new Promise(r => setTimeout(r, ms)) });
    return {
      count: res.rows.length,
      total: res.total,
      languages: res.languages.map(l => l.label + ':' + l.count),
      bestRu: (res.languages.find(l => l.code === 'ru') || {}).best
    };
  });
  check('OpenSubtitles: собраны обе страницы результатов', osAll.count, 5);
  check('OpenSubtitles: языки сгруппированы и отсортированы',
    osAll.languages, ['русский:2', 'английский:1', '日本語:1', 'Deutsch:1']);
  check('OpenSubtitles: лучший вариант языка — самый скачиваемый',
    osAll.bestRu && osAll.bestRu.url.endsWith('/en/subtitles/frieren-s01e05-russian-alt'), true);
  const osRelease = await osPage.evaluate(() => OpenSubs.parseResults(document)[0].release);
  check('OpenSubtitles: имя релиза не дублируется мобильной версией строки',
    osRelease, 'Frieren.S01E05.1080p.WEB');

  check('OpenSubtitles: ссылки достроены до абсолютных',
    osAll.bestRu && osAll.bestRu.url.startsWith('https://www.opensubtitles.com/'), true);

  // ---- сквозной поиск серии через подменённый транспорт ----
  await osPage.addScriptTag({ path: path.join(__dirname, '..', 'extension', 'src', 'osnet.js') });
  const episodeHtml = fsmod.readFileSync(path.join(__dirname, 'os-episode.html'), 'utf8');
  const chain = await osPage.evaluate(async (epHtml) => {
    const asked = [];
    const SHOWS = '<html><body>' +
      '<a href="/en/tvshows/2021-mushoku-tensei-jobless-reincarnation">Mushoku Tensei: Jobless Reincarnation</a>' +
      '<a href="/en/tvshows/2023-mushoku-tensei-ii-jobless-reincarnation">Mushoku Tensei II: Jobless Reincarnation</a>' +
      '<a href="/en/movies/2019-some-other-thing">Some Other Thing</a>' +
      '<a href="/en/tvshows/popular">Popular</a></body></html>';
    const SHOW_PAGE = '<html><body><a href="/en/all/search-tvshows/q-osdb:1005706/season-1/episode-">все серии</a></body></html>';
    OsNet.setTransport({
      text: async (url) => {
        asked.push(url);
        if (url.indexOf('search-all') !== -1) return SHOWS;
        if (url.indexOf('/tvshows/2021-') !== -1) return SHOW_PAGE;
        if (url.indexOf('/tvshows/2023-') !== -1) return '<html><body>нет id</body></html>';
        if (url.indexOf('search-tvshows') !== -1 && url.indexOf('episode-3') !== -1) return epHtml;
        return '<html><body></body></html>';
      }
    });
    const steps = [];
    const res = await OsNet.searchEpisode({
      query: 'Mushoku Tensei: Jobless Reincarnation', season: 1, episode: 3,
      onStep: (t) => steps.push(t)
    });
    OsNet.setTransport(null);
    return {
      total: res.total,
      langs: res.languages.map(l => l.label + ':' + l.count),
      bestRu: (res.languages.find(l => l.code === 'ru') || {}).best,
      show: res.show && res.show.title,
      asked: asked,
      steps: steps.length
    };
  }, episodeHtml);
  check('Сквозной поиск: собраны все строки страницы результатов', chain.total, 5);
  check('Сквозной поиск: языки сгруппированы',
    chain.langs, ['русский:2', 'английский:1', '日本語:1', 'Deutsch:1']);
  check('Сквозной поиск: выбран нужный сериал', chain.show, 'Mushoku Tensei: Jobless Reincarnation');
  check('Сквозной поиск: лучший русский вариант — самый скачиваемый',
    chain.bestRu && chain.bestRu.url.endsWith('/en/subtitles/mt-s01e03-ru2'), true);
  check('Сквозной поиск: запросов ровно три (поиск, сериал, серия)', chain.asked.length, 3);
  check('Сквозной поиск: адрес серии собран правильно',
    chain.asked[2],
    'https://www.opensubtitles.com/en/all/search-tvshows/q-osdb:1005706/hearing_impaired-/machine_translated-/trusted_sources-/season-1/episode-3');
  check('Сквозной поиск: пользователю показаны шаги', chain.steps >= 3, true);

  const fallback = await osPage.evaluate(async (epHtml) => {
    const asked = [];
    OsNet.setTransport({
      text: async (url) => {
        asked.push(url);
        if (url.indexOf('search-all') !== -1 && url.indexOf('S01E03') !== -1) return epHtml;
        return '<html><body></body></html>';
      }
    });
    let res = null, err = null;
    try { res = await OsNet.searchEpisode({ query: 'Неизвестное', season: 1, episode: 3 }); }
    catch (e) { err = e.message; }
    OsNet.setTransport(null);
    return { total: res && res.total, err: err, last: asked[asked.length - 1] };
  }, episodeHtml);
  check('Сериала нет в базе — работает прямой поиск по «название S01E03»', fallback.total, 5);
  check('Запасной запрос содержит номер серии', /S01E03/.test(fallback.last || ''), true);

  const osPassive = await osPage.evaluate(() => document.querySelectorAll('[data-sub-overlay]').length);
  check('OpenSubtitles: на странице без видео оверлей не рисуется',
    osPassive === 0 && osErrors.length === 0, JSON.stringify(osErrors));
  await osPage.close();

  // ---- подгонка субтитров по звуку ----
  // В ролике тон включается всплесками, а субтитры к нему сдвинуты ровно
  // на 2,5 секунды: правильный ответ известен заранее.
  await fpage.close();
  await fpopup.close();

  const syncPage = await ctx.newPage();
  const syncErrors = [];
  syncPage.on('pageerror', e => syncErrors.push(e.message));
  await syncPage.goto(BASE + '/sync-page.html');
  await sleep(1500);

  const syncPopup = await ctx.newPage();
  await syncPopup.goto(popupUrl);
  await sleep(1600);
  await syncPopup.setInputFiles('#fileInput', FIX('sync-subs.srt'));
  await sleep(1200);
  const syncInfo = await syncPopup.textContent('#fileInfo');
  check('Подгонка: субтитры фикстуры загружены', /44 реплик/.test(syncInfo || ''), syncInfo);

  await syncPage.bringToFront();
  await syncPage.evaluate(async () => {
    const v = document.getElementById('v');
    v.playbackRate = 2;          // ускоряем, чтобы тест не шёл минуту
    v.currentTime = 0;
    try { await v.play(); } catch (e) {}
  });
  await sleep(600);

  // Разговор с нужной вкладкой: адресов вкладок расширение не знает
  // (и незачем), поэтому просто спрашиваем каждую, как это делает попап.
  async function talkToVideoTab(message) {
    return syncPopup.evaluate(async (msg) => {
      const tabs = await new Promise(r => chrome.tabs.query({}, r));
      for (const t of tabs) {
        const res = await new Promise(r => chrome.tabs.sendMessage(
          t.id, msg, { frameId: 0 }, x => r(chrome.runtime.lastError ? null : x)));
        if (res) return res;
      }
      return null;
    }, message);
  }
  async function videoTabSub() {
    const res = await talkToVideoTab({ type: 'PING' });
    const frames = (res && res.frames) || [];
    for (const f of frames) if (f.sub && f.sub.count === 44) return f.sub;
    return null;
  }

  // сначала кнопка в попапе: она должна запустить прослушивание
  await syncPopup.evaluate(() => document.getElementById('autoSync').click());
  await syncPage.bringToFront();
  await sleep(1200);
  const syncStarted = await videoTabSub();
  check('Подгонка: кнопка в попапе запускает прослушивание',
    !!(syncStarted && syncStarted.sync && syncStarted.sync.running), true);
  await talkToVideoTab({ type: 'ACTION', msg: { type: 'CANCEL_SYNC' } });
  await sleep(300);

  // теперь короткий прогон, чтобы тест не ждал полторы минуты
  await talkToVideoTab({ type: 'ACTION', msg: { type: 'AUTO_SYNC', minSeconds: 20, maxSeconds: 40 } });
  await syncPage.bringToFront();

  let syncDone = null;
  for (let i = 0; i < 50 && !syncDone; i++) {
    await sleep(1000);
    const sub = await videoTabSub();
    if (sub && sub.sync && !sub.sync.running) syncDone = { sync: sub.sync, shift: sub.shift };
  }
  check('Подгонка: сдвиг найден по звуку',
    !!syncDone && syncDone.sync.shift !== null && Math.abs(syncDone.sync.shift - 2.5) <= 0.25,
    JSON.stringify(syncDone));
  check('Подгонка: найденный сдвиг сразу применён к субтитрам',
    !!syncDone && Math.abs(syncDone.shift - syncDone.sync.shift) < 0.001, true);
  check('Подгонка: воспроизведение не сломалось',
    await syncPage.evaluate(() => { const v = document.getElementById('v'); return !v.paused && v.currentTime > 1; }),
    true);
  check('Подгонка: без ошибок на странице', syncErrors.length === 0, true);
  await syncPopup.close();
  await syncPage.close();

  check('Нет ошибок в консоли страницы', realErrors.length === 0, realErrors.join(' | ') || ('всего сообщений: ' + errors.length));
  check('Нет ошибок в попапе', popupErrors.length === 0, popupErrors.join(' | '));

  fsmod.writeFileSync(FIX('results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
