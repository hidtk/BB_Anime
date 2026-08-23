# Автотесты

Прогон в реальном Chromium через Playwright: 41 проверка.

```bash
sh make-video.sh                  # сгенерировать тестовый ролик (нужен ffmpeg)
npm i playwright
npx playwright install chromium   # если браузер ещё не скачан
node server.js &                  # локальный сервер с поддержкой Range-запросов
node run.js                       # на Linux без экрана: xvfb-run -a node run.js
```

`run.js` загружает расширение из `../extension`, открывает тестовые страницы
(`page.html` — псевдо-SPA плеер, `iframe.html` — плеер в чужом фрейме,
`shadow.html` — видео внутри Shadow DOM, `novideo.html` — страница без видео)
и печатает список проверок с PASS/FAIL.
