/*
 * subsync.js — подгонка субтитров под видео по звуку.
 *
 * Идея простая. У файла субтитров есть свой «ритм»: в какие секунды кто-то
 * говорит, а в какие тишина. У видео этот ритм слышно. Мы записываем
 * громкость речевых частот, строим такую же дорожку «говорят / молчат» и
 * ищем сдвиг, при котором две дорожки совпадают лучше всего.
 *
 * Здесь только математика — запись звука живёт в content.js, чтобы эту
 * часть можно было проверять тестами без браузера.
 */
(function (root) {
  'use strict';

  var DT = 0.04;           // шаг дорожки, с
  var MAX_SHIFT = 25;      // насколько далеко ищем сдвиг, с

  // Дорожка субтитров: 1 там, где реплика на экране.
  function cueEnvelope(cues, t0, dt, n) {
    var out = new Float64Array(n);
    if (!cues || !cues.length) return out;
    for (var c = 0; c < cues.length; c++) {
      var from = Math.ceil((cues[c].start - t0) / dt);
      var to = Math.floor((cues[c].end - t0) / dt);
      if (to < 0 || from >= n) continue;
      if (from < 0) from = 0;
      if (to >= n) to = n - 1;
      for (var i = from; i <= to; i++) out[i] = 1;
    }
    return out;
  }

  // Замеры громкости раскладываем по корзинам времени. Там, где ничего не
  // писалось (пауза, перемотка), остаётся дырка — её просто не учитываем.
  function bucketLevels(samples, t0, dt, n) {
    var sum = new Float64Array(n);
    var cnt = new Float64Array(n);
    for (var i = 0; i < samples.length; i++) {
      var idx = Math.floor((samples[i].time - t0) / dt);
      if (idx < 0 || idx >= n) continue;
      sum[idx] += samples[i].level;
      cnt[idx] += 1;
    }
    var out = new Float64Array(n);
    var mask = new Uint8Array(n);
    for (var j = 0; j < n; j++) {
      if (!cnt[j]) continue;
      out[j] = sum[j] / cnt[j];
      mask[j] = 1;
    }
    return { level: out, mask: mask };
  }

  function median(values) {
    if (!values.length) return 0;
    var a = Array.prototype.slice.call(values).sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /*
   * Громкость превращаем в «говорят / молчат». Порог берём от медианы и
   * медианного отклонения: так дорожка не зависит от того, насколько
   * громко сведена конкретная серия, и переживает музыку под диалогом.
   */
  function speechEnvelope(level, mask) {
    var live = [];
    for (var i = 0; i < level.length; i++) if (mask[i]) live.push(level[i]);
    if (live.length < 8) return new Float64Array(level.length);
    var med = median(live);
    var dev = [];
    for (var j = 0; j < live.length; j++) dev.push(Math.abs(live[j] - med));
    var mad = median(dev) || 1e-6;
    var threshold = med + 0.6 * mad;
    var out = new Float64Array(level.length);
    for (var k = 0; k < level.length; k++) out[k] = mask[k] && level[k] > threshold ? 1 : 0;
    return out;
  }

  /*
   * Ищем сдвиг: реплика из файла с временем C показывается на видео в
   * момент C + shift, поэтому сравниваем observed[i] с expected[i - lag].
   * Считаем обычную корреляцию по перекрытию — так разная длина куска не
   * тянет ответ в сторону длинных сдвигов.
   */
  function correlate(observed, expected, mask, maxLag) {
    var n = observed.length;
    var scores = [];
    var best = { lag: 0, score: -2 };
    for (var lag = -maxLag; lag <= maxLag; lag++) {
      var so = 0, se = 0, soo = 0, see = 0, soe = 0, cnt = 0;
      for (var i = 0; i < n; i++) {
        var j = i - lag;
        if (j < 0 || j >= n) continue;
        if (mask && !mask[i]) continue;
        var o = observed[i], e = expected[j];
        so += o; se += e; soo += o * o; see += e * e; soe += o * e; cnt++;
      }
      if (cnt < 40) { scores.push(0); continue; }
      var mo = so / cnt, me = se / cnt;
      var varO = soo / cnt - mo * mo;
      var varE = see / cnt - me * me;
      var score = (varO <= 1e-9 || varE <= 1e-9) ? 0 : (soe / cnt - mo * me) / Math.sqrt(varO * varE);
      scores.push(score);
      if (score > best.score) { best = { lag: lag, score: score }; }
    }
    return { best: best, scores: scores, maxLag: maxLag };
  }

  // Насколько ответ выделяется среди остальных: пик против общего фона и
  // против второго по величине пика, стоящего в стороне.
  function judge(result, dt) {
    var scores = result.scores;
    var n = scores.length;
    var sum = 0, sum2 = 0;
    for (var i = 0; i < n; i++) { sum += scores[i]; sum2 += scores[i] * scores[i]; }
    var mean = sum / n;
    var sd = Math.sqrt(Math.max(sum2 / n - mean * mean, 1e-12));
    var z = (result.best.score - mean) / sd;

    var guard = Math.max(1, Math.round(0.75 / dt)); // ±0.75 с вокруг пика
    var runnerUp = -2;
    for (var k = 0; k < n; k++) {
      var lag = k - result.maxLag;
      if (Math.abs(lag - result.best.lag) <= guard) continue;
      if (scores[k] > runnerUp) runnerUp = scores[k];
    }
    return { z: z, runnerUp: runnerUp, margin: result.best.score - runnerUp };
  }

  /*
   * Главная функция. samples — [{time, level}], cues — разобранные реплики.
   * Возвращает { ok, shift, score, confidence, reason }.
   */
  function estimateShift(opts) {
    opts = opts || {};
    var samples = opts.samples || [];
    var cues = opts.cues || [];
    var dt = opts.dt || DT;
    var maxShift = opts.maxShift || MAX_SHIFT;

    if (samples.length < 200) return { ok: false, reason: 'мало записанного звука' };
    if (cues.length < 8) return { ok: false, reason: 'слишком мало реплик' };

    // Перемотки во время записи допустимы: замеры привязаны к времени
    // видео, поэтому просто берём весь охваченный отрезок.
    var t0 = samples[0].time, t1 = samples[0].time;
    for (var s = 1; s < samples.length; s++) {
      if (samples[s].time < t0) t0 = samples[s].time;
      if (samples[s].time > t1) t1 = samples[s].time;
    }
    var span = t1 - t0;
    if (span < 15) return { ok: false, reason: 'слишком короткий кусок' };

    var n = Math.ceil(span / dt) + 1;
    var got = bucketLevels(samples, t0, dt, n);
    var observed = speechEnvelope(got.level, got.mask);
    var expected = cueEnvelope(cues, t0, dt, n);

    var talk = 0;
    for (var i = 0; i < observed.length; i++) talk += observed[i];
    if (talk < 20) return { ok: false, reason: 'в этом куске почти не говорят' };

    var maxLag = Math.round(maxShift / dt);
    if (maxLag > n - 40) maxLag = Math.max(1, n - 40);
    var res = correlate(observed, expected, got.mask, maxLag);
    var q = judge(res, dt);

    var shift = res.best.lag * dt;
    var confident = res.best.score >= 0.12 && q.z >= 3.5 && q.margin >= 0.03;
    return {
      ok: confident,
      shift: Math.round(shift * 100) / 100,
      score: Math.round(res.best.score * 1000) / 1000,
      confidence: Math.round(q.z * 10) / 10,
      margin: Math.round(q.margin * 1000) / 1000,
      reason: confident ? '' : 'совпадение слишком слабое'
    };
  }

  var API = {
    DT: DT,
    MAX_SHIFT: MAX_SHIFT,
    cueEnvelope: cueEnvelope,
    bucketLevels: bucketLevels,
    speechEnvelope: speechEnvelope,
    correlate: correlate,
    judge: judge,
    estimateShift: estimateShift
  };

  root.SubSync = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
