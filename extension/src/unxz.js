/*
 * unxz.js — распаковка .xz (LZMA2) прямо в браузере, без библиотек.
 *
 * AnimeTosho отдаёт вытащенные из релизов дорожки субтитров в виде
 * файлов .ass.xz. Браузер умеет gzip и deflate, но не xz, поэтому
 * распаковщик приходится нести с собой. Здесь только чтение: сжимать
 * ничего не нужно.
 *
 * Формат разбирается по спецификации xz (заголовок потока → блоки →
 * куски LZMA2) и классическому декодеру LZMA.
 */
(function (root) {
  'use strict';

  var PROB_INIT = 1024;               // вероятность 0.5 в формате 11 бит
  var END_POS_MODEL_INDEX = 14;
  var NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
  var MATCH_MIN_LEN = 2;

  // ---------------- арифметический декодер ----------------

  function RangeDecoder(buf, pos, end) {
    this.buf = buf;
    this.pos = pos + 1;               // первый байт потока всегда нулевой
    this.end = end;
    this.range = 0xFFFFFFFF >>> 0;
    this.code = 0;
    for (var i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  RangeDecoder.prototype.byte = function () {
    return this.pos < this.end ? this.buf[this.pos++] : 0;
  };
  RangeDecoder.prototype.normalize = function () {
    if (this.range >>> 24 === 0) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  };
  RangeDecoder.prototype.bit = function (probs, index) {
    var p = probs[index];
    var bound = ((this.range >>> 11) * p) >>> 0;
    var sym;
    if ((this.code >>> 0) < bound) {
      this.range = bound;
      probs[index] = p + ((2048 - p) >>> 5);
      sym = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[index] = p - (p >>> 5);
      sym = 1;
    }
    this.normalize();
    return sym;
  };
  RangeDecoder.prototype.direct = function (count) {
    var res = 0;
    for (var i = 0; i < count; i++) {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      var t = (0 - (this.code >>> 31)) >>> 0;       // 0xFFFFFFFF, если ушли в минус
      this.code = (this.code + (this.range & t)) >>> 0;
      res = ((res << 1) + (((t + 1) >>> 0) & 1)) >>> 0;
      this.normalize();
    }
    return res;
  };

  function treeDecode(rc, probs, offset, bits) {
    var m = 1;
    for (var i = 0; i < bits; i++) m = (m << 1) + rc.bit(probs, offset + m);
    return m - (1 << bits);
  }
  function treeDecodeReverse(rc, probs, offset, bits) {
    var m = 1, sym = 0;
    for (var i = 0; i < bits; i++) {
      var b = rc.bit(probs, offset + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }

  // ---------------- декодер длин совпадений ----------------

  function LenDecoder() { this.reset(); }
  LenDecoder.prototype.reset = function () {
    this.choice = new Uint16Array(2).fill(PROB_INIT);
    this.low = new Uint16Array(16 * 8).fill(PROB_INIT);
    this.mid = new Uint16Array(16 * 8).fill(PROB_INIT);
    this.high = new Uint16Array(256).fill(PROB_INIT);
  };
  LenDecoder.prototype.decode = function (rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return treeDecode(rc, this.low, posState * 8, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + treeDecode(rc, this.mid, posState * 8, 3);
    return 16 + treeDecode(rc, this.high, 0, 8);
  };

  // ---------------- собственно LZMA ----------------

  function Lzma() {
    this.out = new Uint8Array(1 << 16);
    this.outPos = 0;
    this.setProps(0x5D);              // lc=3, lp=0, pb=2 — обычные значения
    this.resetState();
  }

  Lzma.prototype.setProps = function (byte) {
    if (byte > (4 * 5 + 4) * 9 + 8) throw new Error('битые параметры LZMA');
    var v = byte;
    this.lc = v % 9; v = (v - this.lc) / 9;
    this.lp = v % 5;
    this.pb = (v - this.lp) / 5;
  };

  Lzma.prototype.resetState = function () {
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.isMatch = new Uint16Array(12 << 4).fill(PROB_INIT);
    this.isRep = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG0 = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG1 = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG2 = new Uint16Array(12).fill(PROB_INIT);
    this.isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
    this.posSlot = new Uint16Array(4 * 64).fill(PROB_INIT);
    this.posDecoders = new Uint16Array(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX).fill(PROB_INIT);
    this.align = new Uint16Array(16).fill(PROB_INIT);
    this.literals = new Uint16Array(0x300 << (this.lc + this.lp)).fill(PROB_INIT);
    this.lenDec = new LenDecoder();
    this.repLenDec = new LenDecoder();
  };

  Lzma.prototype.grow = function (need) {
    if (this.outPos + need <= this.out.length) return;
    var size = this.out.length;
    while (size < this.outPos + need) size *= 2;
    var bigger = new Uint8Array(size);
    bigger.set(this.out.subarray(0, this.outPos));
    this.out = bigger;
  };

  Lzma.prototype.putByte = function (b) {
    this.grow(1);
    this.out[this.outPos++] = b;
  };

  Lzma.prototype.byteAtDistance = function (dist) {
    var i = this.outPos - dist - 1;
    if (i < this.dictStart - 1 || i < 0) throw new Error('ссылка за пределы словаря');
    return this.out[i];
  };

  Lzma.prototype.decodeLiteral = function (rc) {
    var prevByte = this.outPos > 0 ? this.out[this.outPos - 1] : 0;
    var litState = (((this.outPos & ((1 << this.lp) - 1)) << this.lc) +
      (prevByte >> (8 - this.lc))) >>> 0;
    var offset = 0x300 * litState;
    var symbol = 1;

    if (this.state >= 7) {
      // после совпадения байты кодируются с оглядкой на предыдущее
      var matchByte = this.byteAtDistance(this.rep0);
      do {
        var matchBit = (matchByte >> 7) & 1;
        matchByte = (matchByte << 1) & 0xFF;
        var bit = rc.bit(this.literals, offset + ((1 + matchBit) << 8) + symbol);
        symbol = (symbol << 1) | bit;
        if (matchBit !== bit) break;
      } while (symbol < 0x100);
    }
    while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literals, offset + symbol);
    this.putByte(symbol & 0xFF);
    this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
  };

  Lzma.prototype.decodeDistance = function (rc, len) {
    var lenState = len < 4 ? len : 3;
    var posSlot = treeDecode(rc, this.posSlot, lenState * 64, 6);
    if (posSlot < 4) return posSlot;
    var direct = (posSlot >> 1) - 1;
    var dist = ((2 | (posSlot & 1)) << direct) >>> 0;
    if (posSlot < END_POS_MODEL_INDEX) {
      dist = (dist + treeDecodeReverse(rc, this.posDecoders, dist - posSlot, direct)) >>> 0;
    } else {
      dist = (dist + (rc.direct(direct - 4) * 16)) >>> 0;
      dist = (dist + treeDecodeReverse(rc, this.align, 0, 4)) >>> 0;
    }
    return dist;
  };

  Lzma.prototype.copyMatch = function (len, dist) {
    this.grow(len);
    var from = this.outPos - dist - 1;
    if (from < 0) throw new Error('ссылка за пределы словаря');
    for (var i = 0; i < len; i++) this.out[this.outPos++] = this.out[from++];
  };

  // Один кусок LZMA2: декодируем ровно unpackSize байт.
  Lzma.prototype.decodeChunk = function (buf, pos, packEnd, unpackSize) {
    var rc = new RangeDecoder(buf, pos, packEnd);
    var target = this.outPos + unpackSize;
    var posMask = (1 << this.pb) - 1;

    while (this.outPos < target) {
      var posState = this.outPos & posMask;
      if (rc.bit(this.isMatch, (this.state << 4) + posState) === 0) {
        this.decodeLiteral(rc);
        continue;
      }
      var len;
      if (rc.bit(this.isRep, this.state) !== 0) {
        // повтор одного из последних расстояний
        if (rc.bit(this.isRepG0, this.state) === 0) {
          if (rc.bit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11;
            this.putByte(this.byteAtDistance(this.rep0));
            continue;
          }
        } else {
          var dist;
          if (rc.bit(this.isRepG1, this.state) === 0) {
            dist = this.rep1;
          } else {
            if (rc.bit(this.isRepG2, this.state) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.repLenDec.decode(rc, posState) + MATCH_MIN_LEN;
        this.state = this.state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
        len = this.lenDec.decode(rc, posState);
        this.state = this.state < 7 ? 7 : 10;
        this.rep0 = this.decodeDistance(rc, len);
        if (this.rep0 === 0xFFFFFFFF) return rc.pos;   // маркер конца
        len += MATCH_MIN_LEN;
      }
      this.copyMatch(len, this.rep0);
    }
    return rc.pos;
  };

  // ---------------- LZMA2 ----------------

  function decodeLzma2(buf, pos, end) {
    var lz = new Lzma();
    lz.dictStart = 0;
    var needProps = true;

    while (pos < end) {
      var control = buf[pos++];
      if (control === 0) break;                      // конец данных

      if (control < 3) {
        // кусок лежит как есть, без сжатия
        var rawSize = ((buf[pos] << 8) | buf[pos + 1]) + 1;
        pos += 2;
        lz.grow(rawSize);
        lz.out.set(buf.subarray(pos, pos + rawSize), lz.outPos);
        lz.outPos += rawSize;
        pos += rawSize;
        lz.resetState();
        needProps = false;
        continue;
      }
      if (control < 0x80) throw new Error('непонятный кусок LZMA2');

      var unpackSize = (((control & 0x1F) << 16) | (buf[pos] << 8) | buf[pos + 1]) + 1;
      pos += 2;
      var packSize = ((buf[pos] << 8) | buf[pos + 1]) + 1;
      pos += 2;
      var mode = (control >> 5) & 3;

      if (mode >= 2) { lz.setProps(buf[pos++]); needProps = false; }
      else if (needProps) throw new Error('в потоке нет параметров LZMA');
      if (mode >= 1) lz.resetState();

      var after = lz.decodeChunk(buf, pos, pos + packSize, unpackSize);
      void after;
      pos += packSize;
    }
    return { data: lz.out.slice(0, lz.outPos), pos: pos };
  }

  // ---------------- контейнер xz ----------------

  function readVarint(buf, pos) {
    var value = 0, shift = 0, b;
    do {
      b = buf[pos++];
      value += (b & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (shift > 63) throw new Error('слишком длинное число в заголовке');
    } while (b & 0x80);
    return { value: value, pos: pos };
  }

  function isXz(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    return b.length > 12 && b[0] === 0xFD && b[1] === 0x37 && b[2] === 0x7A &&
      b[3] === 0x58 && b[4] === 0x5A && b[5] === 0x00;
  }

  // Размер поля проверки в конце каждого блока — зависит от флагов потока.
  function checkSize(checkId) {
    if (checkId === 0) return 0;
    if (checkId <= 3) return 4;      // CRC32
    if (checkId <= 6) return 8;      // CRC64
    if (checkId <= 9) return 16;
    return 32;                        // SHA-256
  }

  function decompress(input) {
    var buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isXz(buf)) throw new Error('это не файл .xz');

    var checkId = buf[7] & 0x0F;
    var pos = 12;                     // заголовок потока: подпись, флаги, CRC
    var parts = [];
    var total = 0;

    while (pos < buf.length) {
      var first = buf[pos];
      if (first === 0) break;         // начался индекс — блоков больше нет
      var headerSize = (first + 1) * 4;
      var headerEnd = pos + headerSize;
      var p = pos + 1;
      var flags = buf[p++];
      var filters = (flags & 0x03) + 1;
      if (flags & 0x40) p = readVarint(buf, p).pos;   // размер сжатых данных
      if (flags & 0x80) p = readVarint(buf, p).pos;   // размер исходных данных

      var lzma2Seen = false;
      for (var f = 0; f < filters; f++) {
        var id = readVarint(buf, p); p = id.pos;
        var propSize = readVarint(buf, p); p = propSize.pos;
        if (id.value === 0x21) lzma2Seen = true;
        else throw new Error('в файле незнакомый фильтр xz');
        p += propSize.value;
      }
      if (!lzma2Seen) throw new Error('в файле нет данных LZMA2');

      var block = decodeLzma2(buf, headerEnd, buf.length);
      parts.push(block.data);
      total += block.data.length;

      // после данных идут выравнивание до четырёх байт и поле проверки —
      // за ними начинается следующий блок (обычно его просто нет)
      var next = block.pos;
      while ((next - headerEnd) % 4 !== 0) next++;
      next += checkSize(checkId);
      if (next <= pos) break;
      pos = next;
    }

    if (parts.length === 1) return parts[0];
    var out = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }

  var API = { isXz: isXz, decompress: decompress };
  root.UnXz = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
