// exp11 engine — streaming byte CLI for site-generator-speed (own code).
//
// Architecture (measured, see build-log § Stage 4): custom main.ts sets
// Sparkplug-only V8 flags, then runCli() reads cases.json as raw bytes,
// parses each case with a zero-decode streaming JSON parser (md content is
// never decoded to JS strings — it stays a byte range in the raw buffer,
// unescaped in place), renders each case straight into a 1 MB output arena
// that is flushed with writeSync, and never calls JSON.parse/JSON.stringify
// on the 2.9 MB input / 7.4 MB output. A guarded fast path handles the
// common shapes; anything unusual falls back to the exact string engine
// (fallback.cjs — exp7 solve.js, proven byte-identical) for that case.
//
// The output bytes are already valid JSON: the markdown renderer emits
// JSON-escaped HTML directly (newline as the two bytes \ n, quote as \"),
// and template slots are stored pre-escaped. There is no serialize step.

const { readFileSync, openSync, writeSync, closeSync } = require('node:fs');

// ---------------------------------------------------------------- output arena
const OUT_CAP = 1048576;
let _outBuf = null; // Buffer (1 MB)
let _outU8 = null;  // Uint8Array view of _outBuf
let _outOff = 0;
let _outFd = -1;
function outFlush() {
  if (_outOff > 0) { writeSync(_outFd, _outU8, 0, _outOff); _outOff = 0; }
}
function outByte(b) { if (_outOff >= OUT_CAP) outFlush(); _outU8[_outOff++] = b; }
function outBytes(src, a, b) {
  // Copy bytes [a,b) of src into the output arena, flushing as needed.
  let n = b - a;
  if (n <= 0) return;
  if (_outOff + n > OUT_CAP) {
    outFlush();
    if (n >= OUT_CAP) { writeSync(_outFd, src, a, n); return; }
  }
  _outU8.set(src.subarray(a, b), _outOff); _outOff += n;
}
function outAscii(str) {
  // str is ASCII-only (paths, keys, small literals). latin1Write is exact.
  const n = str.length;
  if (n === 0) return;
  if (_outOff + n > OUT_CAP) {
    outFlush();
    if (n >= OUT_CAP) { writeSync(_outFd, str); return; }
  }
  _outOff += _outBuf.latin1Write(str, _outOff);
}
function outUtf8(str) {
  if (str.length === 0) return;
  const need = str.length * 3;
  if (_outOff + need > OUT_CAP) {
    outFlush();
    if (need >= OUT_CAP) { writeSync(_outFd, str); return; }
  }
  _outOff += _outBuf.utf8Write(str, _outOff);
}

// ---------------------------------------------------------------- string arena
// Decoded small strings (paths, template sources, slot values) live here as
// (offset,length) pairs into one reusable Buffer; no per-string allocation
// in the hot path. Grows on demand.
let _strBuf = Buffer.allocUnsafe(1 << 20);
let _strU8 = new Uint8Array(_strBuf.buffer, _strBuf.byteOffset, _strBuf.byteLength);
let _strOff = 0;
function strEnsure(need) {
  if (_strOff + need > _strBuf.length) {
    let ncap = _strBuf.length * 2;
    while (_strOff + need > ncap) ncap *= 2;
    const nb = Buffer.allocUnsafe(ncap);
    _strBuf.copy(nb, 0, 0, _strOff);
    _strBuf = nb;
    _strU8 = new Uint8Array(nb.buffer, nb.byteOffset, nb.byteLength);
  }
  return _strOff;
}
function strWriteUtf8(str) {
  const need = str.length * 3 + 16;
  strEnsure(need);
  const o = _strOff, n = _strBuf.utf8Write(str, o);
  _strOff = o + n;
  return o; // caller pairs with length n
}
function strWriteAscii(str) {
  const n = str.length;
  strEnsure(n + 16);
  const o = _strOff;
  _strBuf.latin1Write(str, o);
  _strOff = o + n;
  return o;
}

// ---------------------------------------------------------------- JSON streaming parser
// All functions take (u, buf, p): u = Uint8Array over the raw file, buf = the
// Buffer (for utf8Slice/latin1Slice), p = parse index. Results go to _jp
// (index just past the parsed value) plus return values / _u* globals.

let _jp = 0;       // parse index after the last parsed value
let _uEnd = 0;     // tf_unesc: end of unescaped content
let _uNext = 0;    // tf_unesc: index just past the closing quote
let _uFlags = 0;   // tf_unesc: bit 1 = has CR, bit 2 = lone surrogate
let _uLoneCp = 0;  // tf_unesc: the lone surrogate code unit (for slow path)

function skipWs(u, p) {
  const n = u.length;
  while (p < n) {
    const c = u[p];
    if (c === 32 || c === 10 || c === 13 || c === 9) p++;
    else break;
  }
  return p;
}

// Index of the closing quote of the JSON string starting at p (u[p] === '"'),
// skipping escaped quotes. p is the index of the opening quote.
function findStrEnd(u, p) {
  let q = u.indexOf(34, p + 1);
  while (q !== -1 && u[q - 1] === 92) {
    let k = q - 2;
    while (k >= 0 && u[k] === 92) k--;
    if (((q - 1 - k) & 1) === 0) return q; // even run of backslashes: real quote
    q = u.indexOf(34, q + 1);
  }
  return q;
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 97 + 10;
  if (c >= 65 && c <= 70) return c - 65 + 10;
  return -1;
}

// Unescape the JSON string whose content starts at `start` (just after the
// opening quote), IN PLACE on u. Returns 0 on success, -1 if a lone
// surrogate was hit (caller must decline the fast path for this case).
// Sets _uEnd (end of unescaped content), _uNext (past closing quote),
// _uFlags (bit1 hasCR, bit2 loneSurrogate), _uLoneCp.
function tf_unesc(u, start) {
  _uFlags = 0;
  const q = u.indexOf(34, start);
  const bs = u.indexOf(92, start);
  if (bs === -1 || bs > q) { _uEnd = q; _uNext = q + 1; return 0; }
  const endQ = findStrEnd(u, bs + 2);
  let o = bs, i = bs;
  while (true) {
    const e = u[i + 1];
    if (e === 110) { // \n
      u[o++] = 10; i += 2;
      while (u[i] === 92 && u[i + 1] === 110) { u[o++] = 10; i += 2; }
    } else if (e === 34) { u[o++] = 34; i += 2; }
    else if (e === 92) { u[o++] = 92; i += 2; }
    else if (e === 47) { u[o++] = 47; i += 2; }
    else if (e === 116) { u[o++] = 9; i += 2; }
    else if (e === 114) { u[o++] = 13; _uFlags |= 1; i += 2; }
    else if (e === 98) { u[o++] = 8; i += 2; }
    else if (e === 102) { u[o++] = 12; i += 2; }
    else if (e === 117) { // \uXXXX
      const h0 = hexVal(u[i + 2]), h1 = hexVal(u[i + 3]), h2 = hexVal(u[i + 4]), h3 = hexVal(u[i + 5]);
      if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) return -1;
      let cp = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
      i += 6;
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        // High surrogate: must be followed by \uDC00-\uDFFF.
        if (u[i] === 92 && u[i + 1] === 117) {
          const g0 = hexVal(u[i + 2]), g1 = hexVal(u[i + 3]), g2 = hexVal(u[i + 4]), g3 = hexVal(u[i + 5]);
          if (g0 >= 0 && g1 >= 0 && g2 >= 0 && g3 >= 0) {
            const lo = (g0 << 12) | (g1 << 8) | (g2 << 4) | g3;
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              i += 6;
              u[o++] = 0xF0 | (cp >> 18); u[o++] = 0x80 | ((cp >> 12) & 0x3F);
              u[o++] = 0x80 | ((cp >> 6) & 0x3F); u[o++] = 0x80 | (cp & 0x3F);
            } else { _uFlags |= 2; _uLoneCp = cp; _uEnd = o; _uNext = -i; return -1; }
          } else { _uFlags |= 2; _uLoneCp = cp; _uEnd = o; _uNext = -i; return -1; }
        } else { _uFlags |= 2; _uLoneCp = cp; _uEnd = o; _uNext = -i; return -1; }
      } else if (cp >= 0xDC00 && cp <= 0xDFFF) { _uFlags |= 2; _uLoneCp = cp; _uEnd = o; _uNext = -i; return -1; }
      else if (cp < 0x80) { u[o++] = cp; if (cp === 13) _uFlags |= 1; }
      else if (cp < 0x800) { u[o++] = 0xC0 | (cp >> 6); u[o++] = 0x80 | (cp & 0x3F); }
      else { u[o++] = 0xE0 | (cp >> 12); u[o++] = 0x80 | ((cp >> 6) & 0x3F); u[o++] = 0x80 | (cp & 0x3F); }
    } else { // unknown escape: JSON.parse would throw; treat as fatal
      return -1;
    }
    if (i === endQ) { _uEnd = o; _uNext = endQ + 1; return 0; }
    if (i > endQ) { // overshot: re-find the quote from here
      const nq = findStrEnd(u, i);
      _uEnd = o; _uNext = nq + 1; return 0;
    }
    bs2: {
      const nb = u.indexOf(92, i);
      if (nb === -1 || nb > endQ) {
        const rem = endQ - i;
        if (rem > 0) { u.copyWithin(o, i, endQ); o += rem; }
        _uEnd = o; _uNext = endQ + 1; return 0;
      }
      const run = nb - i;
      if (run > 0) {
        if (run <= 16) { while (i < nb) u[o++] = u[i++]; }
        else { u.copyWithin(o, i, nb); o += run; i = nb; }
      }
      i = nb;
    }
  }
}

// Read a JSON string at p (u[p] === '"') as a JS string. Sets _jp.
function readStr(u, buf, p) {
  const start = p + 1, q = u.indexOf(34, start), bs = u.indexOf(92, start);
  if (bs === -1 || bs > q) { _jp = q + 1; return buf.utf8Slice(start, q); }
  const endQ = findStrEnd(u, bs + 2);
  _jp = endQ + 1;
  return JSON.parse(buf.utf8Slice(p, endQ + 1));
}

// Read any JSON value at p. Sets _jp.
function readVal(u, buf, p) {
  p = skipWs(u, p);
  const c = u[p];
  if (c === 34) return readStr(u, buf, p);
  if (c === 123) {
    const obj = {};
    p = skipWs(u, p + 1);
    if (u[p] === 125) { _jp = p + 1; return obj; }
    while (true) {
      p = skipWs(u, p);
      const key = readStr(u, buf, p);
      p = skipWs(u, _jp);
      p++; // ':'
      const val = readVal(u, buf, p);
      if (key === '__proto__') Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
      else obj[key] = val;
      p = skipWs(u, _jp);
      if (u[p] === 44) { p++; continue; }
      _jp = p + 1; return obj;
    }
  }
  if (c === 91) {
    const arr = [];
    p = skipWs(u, p + 1);
    if (u[p] === 93) { _jp = p + 1; return arr; }
    while (true) {
      arr.push(readVal(u, buf, p));
      p = skipWs(u, _jp);
      if (u[p] === 44) { p++; continue; }
      _jp = p + 1; return arr;
    }
  }
  if (c === 116) { _jp = p + 4; return true; }
  if (c === 102) { _jp = p + 5; return false; }
  if (c === 110) { _jp = p + 4; return null; }
  let e = p;
  const n = u.length;
  while (e < n) {
    const ch = u[e];
    if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 46 || ch === 101 || ch === 69 || ch === 43) e++;
    else break;
  }
  _jp = e;
  return Number(buf.latin1Slice(p, e));
}

function isMdPath(path) {
  return path.length > 3 && path.charCodeAt(path.length - 3) === 46 && path.charCodeAt(path.length - 2) === 109 && path.charCodeAt(path.length - 1) === 100;
}

// One file object of the input.files array. md content stays a byte range
// (unescaped in place); anything else keeps its raw quoted span so the
// output can copy it verbatim. Sets _jp past the object.
function readFileObj(u, buf, p) {
  p++; // '{'
  if (u[p] <= 32) p = skipWs(u, p);
  let path = '', str = null, uOff = -1, uLen = 0, hasCR = false, rawQStart = -1, rawQEnd = -1, seenPath = false;
  if (u[p] === 125) { _jp = p + 1; return { path, content: '', uOff: -1, uLen: 0, hasCR: false, rawQStart: -1, rawQEnd: -1 }; }
  while (true) {
    if (u[p] <= 32) p = skipWs(u, p);
    let kind = 0;
    if (u[p] === 34) {
      if (u[p + 1] === 112 && u[p + 2] === 97 && u[p + 3] === 116 && u[p + 4] === 104 && u[p + 5] === 34) { kind = 1; p += 6; }
      else if (u[p + 1] === 99 && u[p + 2] === 111 && u[p + 3] === 110 && u[p + 4] === 116 && u[p + 5] === 101 && u[p + 6] === 110 && u[p + 7] === 116 && u[p + 8] === 34) { kind = 2; p += 9; }
      else { const key = readStr(u, buf, p); p = _jp; if (key === 'path') kind = 1; else if (key === 'content') kind = 2; }
    }
    if (u[p] <= 32) p = skipWs(u, p);
    p++; // ':'
    if (u[p] <= 32) p = skipWs(u, p);
    if (kind === 1) { path = readStr(u, buf, p); p = _jp; seenPath = true; }
    else if (kind === 2 && u[p] === 34) {
      if (seenPath && !isMdPath(path)) {
        // Static file: keep the raw quoted span (already JSON-escaped).
        const endQ = findStrEnd(u, p + 1);
        rawQStart = p; rawQEnd = endQ + 1; str = null; uOff = -1; p = endQ + 1;
      } else {
        // md content (or content before path): unescape in place.
        const start = p + 1;
        _uFlags = 0;
        const ret = tf_unesc(u, start);
        if (ret >= 0) { uOff = start; uLen = _uEnd - start; hasCR = (_uFlags & 1) !== 0; p = _uNext; }
        else {
          // Lone surrogate (or bad escape): decode via JSON.parse, mark byte range dead.
          const endQ = findStrEnd(u, start);
          str = JSON.parse(buf.utf8Slice(p, endQ + 1)); uOff = -1; p = endQ + 1;
        }
      }
    } else { readVal(u, buf, p); p = _jp; }
    if (u[p] <= 32) p = skipWs(u, p);
    if (u[p] === 44) { p++; continue; }
    _jp = p + 1; break;
  }
  if (str === null && rawQStart === -1 && uOff !== -1 && !isMdPath(path)) {
    // content came before path and is not md: materialize the string.
    str = buf.utf8Slice(uOff, uOff + uLen); uOff = -1;
  }
  return { path, content: str, uOff, uLen, hasCR, rawQStart, rawQEnd };
}

function readInputObj(u, buf, p) {
  const obj = { site: null, templates: null, files: null };
  p = skipWs(u, p + 1);
  if (u[p] === 125) { _jp = p + 1; return obj; }
  while (true) {
    p = skipWs(u, p);
    const key = readStr(u, buf, p);
    p = skipWs(u, _jp);
    p++; // ':'
    p = skipWs(u, p);
    if (key === 'files' && u[p] === 91) {
      const files = [];
      p = skipWs(u, p + 1);
      if (u[p] === 93) p++;
      else {
        while (true) {
          p = skipWs(u, p);
          files.push(readFileObj(u, buf, p));
          p = skipWs(u, _jp);
          if (u[p] === 44) { p++; continue; }
          p++; break;
        }
      }
      obj.files = files; _jp = p;
    } else {
      const val = readVal(u, buf, p);
      if (key === 'site') obj.site = val;
      else if (key === 'templates') obj.templates = val;
      else if (key !== '__proto__') obj[key] = val;
    }
    p = skipWs(u, _jp);
    if (u[p] === 44) { p++; continue; }
    _jp = p + 1; return obj;
  }
}

// One case object {id, input}. Returns {input, spanStart, spanEnd} where the
// span is the input object's byte range in the raw buffer (for the fallback
// path, which JSON.parses it). Sets _jp.
function readCaseObj(u, buf, p) {
  let inp = null, spanStart = -1, spanEnd = -1;
  p = skipWs(u, p + 1);
  if (u[p] === 125) { _jp = p + 1; return { input: inp, spanStart, spanEnd }; }
  while (true) {
    p = skipWs(u, p);
    const key = readStr(u, buf, p);
    p = skipWs(u, _jp);
    p++; // ':'
    p = skipWs(u, p);
    if (key === 'input' && u[p] === 123) { spanStart = p; inp = readInputObj(u, buf, p); spanEnd = _jp; }
    else readVal(u, buf, p);
    p = skipWs(u, _jp);
    if (u[p] === 44) { p++; continue; }
    _jp = p + 1; return { input: inp, spanStart, spanEnd };
  }
}

// ---------------------------------------------------------------- string arena helpers (missing pieces)

function strWriteByte(b) {
  if (_strOff >= _strBuf.length) strEnsure(1);
  _strU8[_strOff] = b;
  return ++_strOff;
}

// Decode bytes [s,e) of the CURRENT case's raw buffer as UTF-8.
// (Must use the Buffer, not the Uint8Array view: Uint8Array.toString()
// ignores its arguments and stringifies the whole array.)
function utf8Slice(s, e) { return _rawBuf.toString('utf8', s, e); }

// Module-level reference to the current case's raw input buffer (set by
// runStreamCase). Chunk-2+ byte functions read it as bare `u`; the chunk-1
// parser functions take their own `u` parameter and shadow it.
let u = null;

// Decode pure-ASCII bytes [s,e) into a JS string (fast path).
function asciiSlice(s, e) {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(u[i]);
  return out;
}

// ---------------------------------------------------------------- chunk 2: front matter, slug, words, dates

const FM_KEYS_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_OFF = new Int32Array(12);
const MONTH_LEN = new Int32Array(12);
(function () {
  for (let k = 0; k < 12; k++) { MONTH_OFF[k] = strWriteAscii(MONTH_NAMES[k]); MONTH_LEN[k] = MONTH_NAMES[k].length; }
})();

// String-arena offset where per-case data starts (month names live before it).
const _strBase = _strOff;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Decode a front-matter quoted string's inner bytes (escapes \" and \\ only)
// into the string arena; returns { off, len }.
function decodeFmStr(s, e) {
  let o = strEnsure(e - s);
  const start = o;
  let i = s;
  while (i < e) {
    const c = u[i];
    if (c === 92) { o = strWriteByte(u[i + 1]); i += 2; }
    else { o = strWriteByte(c); i++; }
  }
  return { o: start, l: o - start };
}

// Byte slugify (ASCII fast path identical to the fallback's slugify loop;
// any byte >= 128 falls back to the exact NFKD string path). Reads from
// `srcBuf` — a Buffer (not a Uint8Array view), so .toString() works.
function slugifyU8(s, e, srcBuf) {
  const rb = srcBuf || _rawBuf;
  let o = strEnsure(e - s + 8);
  const start = o;
  let gap = false, outLen = 0, nonAscii = false;
  for (let i = s; i < e; i++) {
    const c = rb[i];
    if (c >= 128) { nonAscii = true; break; }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = outLen > 0; continue; }
    if (gap) { _strU8[o++] = 45; outLen++; }
    gap = false;
    _strU8[o++] = keep; outLen++;
  }
  if (nonAscii) {
    const s2 = slugifyNfkd(rb.toString('utf8', s, e));
    o = strWriteAscii(s2);
    return { o, l: s2.length };
  }
  let len = outLen > 64 ? 64 : outLen;
  while (len > 0 && _strU8[start + len - 1] === 45) len--;
  if (len === 0) { o = strWriteAscii('untitled'); return { o, l: 8 }; }
  _strOff = start + len;
  return { o: start, l: len };
}

// The NFKD path of slugify, on a JS string (exact copy of the fallback).
function slugifyNfkd(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Unique slug against a per-directory Set<string>; the slug lives in the
// string arena. Writes the final slug into the arena, returns { off, len }.
function uniqueSlugU8(off, len, taken) {
  let s = '';
  for (let i = off; i < off + len; i++) s += String.fromCharCode(_strU8[i]);
  let out = s;
  for (let n = 2; taken.has(out); n++) out = s + '-' + n;
  taken.add(out);
  const o = strWriteAscii(out);
  return { o, l: out.length };
}

// Same, but the slug lives in the raw input buffer.
function uniqueSlugRawU8(off, len, taken) {
  let s = asciiSlice(off, off + len);
  let out = s;
  for (let n = 2; taken.has(out); n++) out = s + '-' + n;
  taken.add(out);
  const o = strWriteAscii(out);
  return { o, l: out.length };
}

// The words of a body range: runs of non-whitespace, JS \s semantics
// (ASCII ws + the Unicode whitespace set) over UTF-8 bytes.
function tf_wcU8(s, e) {
  let n = 0, inWord = false;
  let i = s;
  while (i < e) {
    const c = u[i];
    if (c === 32 || (c >= 9 && c <= 13)) { inWord = false; i++; continue; }
    if (c < 128) { if (!inWord) { inWord = true; n++; } i++; continue; }
    let cp = 0, adv = 1;
    if (c >= 0xC2 && c < 0xE0 && i + 1 < e) { cp = ((c & 0x1F) << 6) | (u[i + 1] & 0x3F); adv = 2; }
    else if (c >= 0xE0 && c < 0xF0 && i + 2 < e) { cp = ((c & 0x0F) << 12) | ((u[i + 1] & 0x3F) << 6) | (u[i + 2] & 0x3F); adv = 3; }
    else if (c >= 0xF0 && i + 3 < e) { cp = ((c & 0x07) << 18) | ((u[i + 1] & 0x3F) << 12) | ((u[i + 2] & 0x3F) << 6) | (u[i + 3] & 0x3F); adv = 4; }
    else { cp = 0xFFFD; adv = 1; }
    const ws = cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
    i += adv;
  }
  return n;
}

// Long date "9 November 2026" from a YYYY-MM-DD byte range, into the arena.
function longDateU8(s) {
  const d0 = u[s + 8], d1 = u[s + 9];
  const day = d0 === 48 ? (d1 - 48) : (d0 - 48) * 10 + (d1 - 48);
  const m = (u[s + 5] - 48) * 10 + (u[s + 6] - 48);
  let o = strEnsure(32);
  const start = o;
  if (day >= 10) { _strU8[o++] = 48 + ((day / 10) | 0); _strU8[o++] = 48 + (day % 10); }
  else _strU8[o++] = 48 + day;
  _strU8[o++] = 32;
  const mo = MONTH_OFF[m - 1], ml = MONTH_LEN[m - 1];
  _strU8.copyWithin(o, mo, mo + ml); o += ml;
  _strU8[o++] = 32;
  _strU8.set(u.subarray(s, s + 4), o); o += 4;
  _strOff = o;
  return { o: start, l: o - start };
}

function isDigit(c) { return c >= 48 && c <= 57; }

// Parse one source's front matter (bytes, \n line ends, no \r — guarded).
// Fills src fields; returns an error string or ''.
function parseFmU8(src) {
  const s = src.cOff, e = src.cEnd;
  if (e - s < 3 || u[s] !== 45 || u[s + 1] !== 45 || u[s + 2] !== 45 || (e - s > 3 && u[s + 3] !== 10)) {
    return 'no front matter';
  }
  // Find the closing line: first '\n---\n' at/after offset 3 (byte scan —
  // Uint8Array.indexOf takes numbers only), else trailing '\n---'.
  let closeStart = -1, bodyStart = -1;
  let k = -1;
  let pp = s + 3;
  while (true) {
    const nl = u.indexOf(10, pp);
    if (nl === -1 || nl + 4 >= e) break;
    if (u[nl + 1] === 45 && u[nl + 2] === 45 && u[nl + 3] === 45 && u[nl + 4] === 10) { k = nl; break; }
    pp = nl + 1;
  }
  if (k !== -1) { closeStart = k + 1; bodyStart = k + 5; }
  else if (e - s >= 4 && u[e - 4] === 10 && u[e - 3] === 45 && u[e - 2] === 45 && u[e - 1] === 45) {
    closeStart = e - 3; bodyStart = e;
  }
  if (closeStart === -1) return 'the front matter is not closed';
  const fmStart = s + 4, fmEnd = closeStart - 1;
  let hasTitle = false;
  const seen = {};
  let li = 0;
  let ls = fmStart;
  while (ls <= fmEnd) {
    let le = u.indexOf(10, ls);
    if (le === -1 || le > fmEnd) le = fmEnd + 1;
    const line = ls, lineEnd = le;
    ls = le + 1;
    let p = line, blank = true;
    while (p < lineEnd) { if (u[p] !== 32 && u[p] !== 9) { blank = false; break; } p++; }
    if (blank || u[line] === 35) { li++; continue; }
    let q = line;
    while (q < lineEnd && ((u[q] >= 97 && u[q] <= 122) || u[q] === 95)) q++;
    if (q === line || q >= lineEnd || u[q] !== 58) return `line ${li + 2} is not "key: value"`;
    const keyOff = line, keyLen = q - line;
    let rawS, rawE;
    if (q + 1 === lineEnd) { rawS = lineEnd; rawE = lineEnd; }
    else if (u[q + 1] === 32) { rawS = q + 2; rawE = lineEnd; }
    else return `line ${li + 2} is not "key: value"`;
    while (rawE > rawS && (u[rawE - 1] === 32 || u[rawE - 1] === 9)) rawE--;
    const key = asciiSlice(keyOff, keyOff + keyLen);
    if (!FM_KEYS_SET.has(key)) return `unknown key "${key}"`;
    if (seen[key]) return `key "${key}" is given twice`;
    seen[key] = 1;
    if (key === 'title') hasTitle = true;
    if (rawS === rawE) return `key "${key}" has no value`;
    const err = valueOfU8(src, key, rawS, rawE);
    if (err) return err;
    li++;
  }
  if (!hasTitle) return 'no title';
  src.bodyOff = bodyStart;
  src.bodyEnd = e;
  return '';
}

// One FM key's value, stored on src; returns an error string or ''.
function valueOfU8(src, key, s, e) {
  if (key === 'title' || key === 'summary') {
    if (u[s] === 34) {
      if (e - s < 2 || u[e - 1] !== 34) return `key "${key}": a quoted string is not closed`;
      for (let i = s + 1; i < e - 1; i++) {
        const c = u[i];
        if (c === 92) {
          const n = u[i + 1];
          if ((n !== 34 && n !== 92) || i + 1 === e - 1) return `key "${key}": a quoted string holds an escape other than \\" or \\\\`;
          i++;
        } else if (c === 34) return `key "${key}": a quoted string holds a stray quote`;
      }
      const d = decodeFmStr(s + 1, e - 1);
      if (key === 'title') { src.titleOff = d.o; src.titleLen = d.l; src.titleArena = 1; }
      else { src.summaryOff = d.o; src.summaryLen = d.l; src.hasSummary = 1; src.summaryArena = 1; }
      return '';
    }
    if (u[s] === 91) return `key "${key}": a bare string opens on [`;
    if (key === 'title') { src.titleOff = s; src.titleLen = e - s; src.titleArena = 0; }
    else { src.summaryOff = s; src.summaryLen = e - s; src.hasSummary = 1; src.summaryArena = 0; }
    return '';
  }
  if (key === 'date') {
    const ok = e - s === 10 && isDigit(u[s]) && isDigit(u[s + 1]) && isDigit(u[s + 2]) && isDigit(u[s + 3]) && u[s + 4] === 45 && isDigit(u[s + 5]) && isDigit(u[s + 6]) && u[s + 7] === 45 && isDigit(u[s + 8]) && isDigit(u[s + 9]);
    let y = 0, mo = 0, d = 0;
    if (ok) {
      y = (u[s] - 48) * 1000 + (u[s + 1] - 48) * 100 + (u[s + 2] - 48) * 10 + (u[s + 3] - 48);
      mo = (u[s + 5] - 48) * 10 + (u[s + 6] - 48);
      d = (u[s + 8] - 48) * 10 + (u[s + 9] - 48);
    }
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    }
    src.dateOff = s; src.dateLen = 10; src.dateInt = y * 10000 + mo * 100 + d; src.hasDate = 1;
    return '';
  }
  if (key === 'tags') {
    if (u[s] !== 91 || u[e - 1] !== 93) return 'key "tags": not a list [a, b]';
    const innerS = s + 1, innerE = e - 1;
    let t = innerS;
    while (t < innerE && (u[t] === 32 || u[t] === 9 || u[t] === 11 || u[t] === 12 || u[t] === 13)) t++;
    if (t === innerE) { src.tags = []; return ''; }
    const tags = [];
    let es = innerS;
    while (true) {
      let comma = u.indexOf(44, es);
      if (comma === -1 || comma >= innerE) comma = innerE;
      let a = es, b = comma;
      while (a < b && (u[a] === 32 || u[a] === 9 || u[a] === 11 || u[a] === 12 || u[a] === 13)) a++;
      while (b > a && (u[b - 1] === 32 || u[b - 1] === 9 || u[b - 1] === 11 || u[b - 1] === 12 || u[b - 1] === 13)) b--;
      if (a === b) return 'key "tags": an empty tag, or one holding " [ or ]';
      let bad = false, nonAscii = false;
      for (let i = a; i < b; i++) {
        const c = u[i];
        if (c === 34 || c === 91 || c === 93) { bad = true; break; }
        if (c >= 128) nonAscii = true;
      }
      if (bad) return 'key "tags": an empty tag, or one holding " [ or ]';
      if (nonAscii) {
        const tstr = utf8Slice(a, b);
        if (!/^[^"[\]]+$/.test(tstr)) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
      tags.push({ off: a, len: b - a });
      if (comma === innerE) break;
      es = comma + 1;
    }
    src.tags = tags;
    return '';
  }
  if (key === 'draft') {
    if (e - s === 4 && u[s] === 116 && u[s + 1] === 114 && u[s + 2] === 117 && u[s + 3] === 101) { src.draft = 1; src.hasDraft = 1; return ''; }
    if (e - s === 5 && u[s] === 102 && u[s + 1] === 97 && u[s + 2] === 108 && u[s + 3] === 115 && u[s + 4] === 101) { src.draft = 0; src.hasDraft = 1; return ''; }
    return 'key "draft": true or false';
  }
  if (key === 'layout') {
    for (let i = s; i < e; i++) { const c = u[i]; if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return 'key "layout": not a template name'; }
    src.layoutOff = s; src.layoutLen = e - s; src.hasLayout = 1;
    return '';
  }
  if (key === 'slug') {
    if (e - s > 64) return 'key "slug": not a slug';
    let i = s, seg = 0;
    while (i < e) {
      const c = u[i];
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { seg++; i++; continue; }
      if (c === 45 && seg > 0) { seg = 0; i++; continue; }
      return 'key "slug": not a slug';
    }
    if (seg === 0) return 'key "slug": not a slug';
    src.slugOff = s; src.slugLen = e - s; src.hasSlug = 1;
    return '';
  }
  return `unknown key "${key}"`;
}

// ---------------------------------------------------------------- chunk 3: markdown renderer (byte level, raw HTML)

// Dedicated HTML arena: per-source rendered HTML lives here for the whole
// case (the string arena is for small values; the two must not interleave).
let _htmlBuf = Buffer.allocUnsafe(1 << 21);
let _htmlU8 = new Uint8Array(_htmlBuf.buffer, _htmlBuf.byteOffset, _htmlBuf.byteLength);
let _htmlOff = 0;
function htmlEnsure(need) {
  if (_htmlOff + need <= _htmlBuf.length) return _htmlOff;
  let nl = _htmlBuf.length;
  while (_htmlOff + need > nl) nl *= 2;
  const nb = Buffer.allocUnsafe(nl);
  _htmlBuf.copy(nb, 0, 0, _htmlOff);
  _htmlBuf = nb;
  _htmlU8 = new Uint8Array(nb.buffer, nb.byteOffset, nb.byteLength);
  return _htmlOff;
}
function hByte(b) { if (_htmlOff >= _htmlBuf.length) htmlEnsure(1); _htmlU8[_htmlOff++] = b; }
function hLit(str) {
  let o = htmlEnsure(str.length);
  for (let i = 0; i < str.length; i++) _htmlU8[o++] = str.charCodeAt(i);
  _htmlOff = o;
}
// Copy bytes [s,e) of `buf` into the HTML arena, verbatim.
function hCopyBuf(buf, s, e) {
  let o = htmlEnsure(e - s);
  _htmlU8.set(buf.subarray(s, e), o);
  _htmlOff = o + (e - s);
}
// Copy bytes [s,e) of `buf` into the HTML arena with HTML escaping.
function hEscBuf(buf, s, e) {
  let o = htmlEnsure((e - s) * 6 + 8);
  for (let i = s; i < e; i++) {
    const c = buf[i];
    if (c === 38) { _htmlU8[o++] = 38; _htmlU8[o++] = 97; _htmlU8[o++] = 109; _htmlU8[o++] = 112; _htmlU8[o++] = 59; }
    else if (c === 60) { _htmlU8[o++] = 38; _htmlU8[o++] = 108; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 62) { _htmlU8[o++] = 38; _htmlU8[o++] = 103; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 34) { _htmlU8[o++] = 38; _htmlU8[o++] = 113; _htmlU8[o++] = 117; _htmlU8[o++] = 111; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 39) { _htmlU8[o++] = 38; _htmlU8[o++] = 35; _htmlU8[o++] = 51; _htmlU8[o++] = 57; _htmlU8[o++] = 59; }
    else _htmlU8[o++] = c;
  }
  _htmlOff = o;
}
// Copy bytes [s,e) from the raw buffer, verbatim (no escaping).
function hCopyU8(s, e) {
  let o = htmlEnsure(e - s);
  _htmlU8.set(u.subarray(s, e), o);
  _htmlOff = o + (e - s);
}
// Copy bytes [s,e) from the raw buffer with HTML escaping (& < > " ').
function hEscU8(s, e) {
  let o = htmlEnsure((e - s) * 6 + 8);
  for (let i = s; i < e; i++) {
    const c = u[i];
    if (c === 38) { _htmlU8[o++] = 38; _htmlU8[o++] = 97; _htmlU8[o++] = 109; _htmlU8[o++] = 112; _htmlU8[o++] = 59; }
    else if (c === 60) { _htmlU8[o++] = 38; _htmlU8[o++] = 108; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 62) { _htmlU8[o++] = 38; _htmlU8[o++] = 103; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 34) { _htmlU8[o++] = 38; _htmlU8[o++] = 113; _htmlU8[o++] = 117; _htmlU8[o++] = 111; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 39) { _htmlU8[o++] = 38; _htmlU8[o++] = 35; _htmlU8[o++] = 51; _htmlU8[o++] = 57; _htmlU8[o++] = 59; }
    else _htmlU8[o++] = c;
  }
  _htmlOff = o;
}
// Copy bytes [off,off+len) from the string arena with HTML escaping.
function hEscArena(off, len) {
  let o = htmlEnsure(len * 6 + 8);
  for (let i = off; i < off + len; i++) {
    const c = _strU8[i];
    if (c === 38) { _htmlU8[o++] = 38; _htmlU8[o++] = 97; _htmlU8[o++] = 109; _htmlU8[o++] = 112; _htmlU8[o++] = 59; }
    else if (c === 60) { _htmlU8[o++] = 38; _htmlU8[o++] = 108; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 62) { _htmlU8[o++] = 38; _htmlU8[o++] = 103; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 34) { _htmlU8[o++] = 38; _htmlU8[o++] = 113; _htmlU8[o++] = 117; _htmlU8[o++] = 111; _htmlU8[o++] = 116; _htmlU8[o++] = 59; }
    else if (c === 39) { _htmlU8[o++] = 38; _htmlU8[o++] = 35; _htmlU8[o++] = 51; _htmlU8[o++] = 57; _htmlU8[o++] = 59; }
    else _htmlU8[o++] = c;
  }
  _htmlOff = o;
}
// Copy bytes [off,off+len) from the string arena, verbatim.
function hCopyArena(off, len) {
  let o = htmlEnsure(len);
  _htmlU8.set(_strU8.subarray(off, off + len), o);
  _htmlOff = o + len;
}

// Scratch buffer for joining a block's lines before inline rendering:
// inline constructs (links, emphasis, code spans) can span line boundaries,
// and the fallback renders the lines joined with '\n', so the byte
// pipeline must do the same instead of rendering line by line.
let _scratchBuf = Buffer.allocUnsafe(1 << 16);
let _scratchU8 = new Uint8Array(_scratchBuf.buffer, _scratchBuf.byteOffset, _scratchBuf.byteLength);
function joinLinesU8(lines) {
  let total = 0;
  for (let k = 0; k < lines.length; k++) total += (lines[k][1] - lines[k][0]) + 1;
  if (total > _scratchBuf.length) {
    let nl = _scratchBuf.length;
    while (total > nl) nl *= 2;
    _scratchBuf = Buffer.allocUnsafe(nl);
    _scratchU8 = new Uint8Array(_scratchBuf.buffer, _scratchBuf.byteOffset, _scratchBuf.byteLength);
  }
  let o = 0;
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) _scratchU8[o++] = 10;
    const ls = lines[k][0], le = lines[k][1];
    _scratchU8.set(u.subarray(ls, le), o);
    o += (le - ls);
  }
  return { s: 0, e: o };
}
// Render lines (already trimmed) as one inline span: a single line is
// rendered straight from the raw buffer; several lines go through the
// scratch join so constructs spanning a line boundary still form.
function inlineLinesU8(lines, env) {
  if (lines.length === 1) { tf_inlineU8(_rawBuf, lines[0][0], lines[0][1], env); return; }
  const j = joinLinesU8(lines);
  tf_inlineU8(_scratchBuf, j.s, j.e, env);
}

// Markdown-special byte lookup table (1 = in [\\ ` * [ & < > " ']).
const MD_SP = new Uint8Array(256);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) MD_SP[c] = 1;
const MD_ONLY = new Uint8Array(256);
for (const c of [92, 96, 42, 91]) MD_ONLY[c] = 1;
const ESCAPABLE_CODES = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

// First index in [s,e) of a markdown-special byte, or -1.
function findSpecialU8(buf, s, e) {
  for (let i = s; i < e; i++) if (MD_SP[buf[i]]) return i;
  return -1;
}
function hasMdOnlyU8(buf, s, e) {
  for (let i = s; i < e; i++) if (MD_ONLY[buf[i]]) return true;
  return false;
}

// The first index from `from` where bytes hold `what` outside a backslash
// escape, or -1. `what` is a 1-2 byte ASCII string.
function findUnescapedU8(buf, s, e, what, from) {
  const w0 = what.charCodeAt(0), w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  for (let j = from; j <= e - what.length; j++) {
    if (buf[j] === 92 && j + 1 < e && ESCAPABLE_CODES.has(buf[j + 1])) { j++; continue; }
    if (buf[j] === w0 && (w1 === -1 || buf[j + 1] === w1)) return j;
  }
  return -1;
}

// The first single * from `from` (one whose run is not **), outside an
// escape, or -1.
function findSingleStarU8(buf, s, e, from) {
  for (let j = from; j < e; j++) {
    const c = buf[j];
    if (c === 92 && j + 1 < e && ESCAPABLE_CODES.has(buf[j + 1])) { j++; continue; }
    if (c !== 42) continue;
    if (buf[j + 1] === 42) { j++; continue; }
    return j;
  }
  return -1;
}

// Whether bytes [s,e) hold any JS \s whitespace (ASCII ws or Unicode ws).
function hasWsU8(buf, s, e) {
  for (let i = s; i < e; i++) {
    const c = buf[i];
    if (c === 32 || (c >= 9 && c <= 13)) return true;
    if (c < 128) continue;
    let cp = 0, adv = 1;
    if (c >= 0xC2 && c < 0xE0 && i + 1 < e) { cp = ((c & 0x1F) << 6) | (buf[i + 1] & 0x3F); adv = 2; }
    else if (c >= 0xE0 && c < 0xF0 && i + 2 < e) { cp = ((c & 0x0F) << 12) | ((buf[i + 1] & 0x3F) << 6) | (buf[i + 2] & 0x3F); adv = 3; }
    else if (c >= 0xF0 && i + 3 < e) { cp = ((c & 0x07) << 18) | ((buf[i + 1] & 0x3F) << 12) | ((buf[i + 2] & 0x3F) << 6) | (buf[i + 3] & 0x3F); adv = 4; }
    else { cp = 0xFFFD; adv = 1; }
    if (cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0xFEFF) return true;
    i += adv - 1;
  }
  return false;
}

// Link resolution (exact copy of the fallback's env.link, on JS strings).
function makeLinkFn(src, ctx) {
  const dirParts = src.dir === '' ? [] : src.dir.split('/');
  return function link(target) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    if (rel === '') return target;
    const parts = [...dirParts];
    let ok = true;
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length === 0) { ok = false; break; } parts.pop(); }
      else parts.push(seg);
    }
    if (!ok) { ctx.broken.add(`broken-link ${src.path} -> ${target}`); return target; }
    const path = parts.join('/');
    const hit = ctx.bySource.get(path);
    if (hit !== undefined) return hit.urlStr + frag;
    if (ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
    ctx.broken.add(`broken-link ${src.path} -> ${target}`);
    return target;
  };
}

// Inline renderer: bytes [s,e) of `buf` rendered as inline HTML into the
// HTML arena. `buf` is a Buffer (raw input or the scratch join).
function tf_inlineU8(buf, s, e, env) {
  if (findSpecialU8(buf, s, e) === -1) { hCopyBuf(buf, s, e); return; }
  if (!hasMdOnlyU8(buf, s, e)) { hEscBuf(buf, s, e); return; }
  let i = s;
  while (i < e) {
    // Next special char.
    let j = i;
    while (j < e && !MD_SP[buf[j]]) j++;
    if (j > i) { hCopyBuf(buf, i, j); i = j; if (i >= e) break; }
    const c = buf[i];
    if (c === 38) { hLit('&amp;'); i++; continue; }
    if (c === 60) { hLit('&lt;'); i++; continue; }
    if (c === 62) { hLit('&gt;'); i++; continue; }
    if (c === 34) { hLit('&quot;'); i++; continue; }
    if (c === 39) { hLit('&#39;'); i++; continue; }
    if (c === 92 && i + 1 < e && ESCAPABLE_CODES.has(buf[i + 1])) {
      const n = buf[i + 1];
      if (n === 38) hLit('&amp;');
      else if (n === 60) hLit('&lt;');
      else if (n === 62) hLit('&gt;');
      else if (n === 34) hLit('&quot;');
      else if (n === 39) hLit('&#39;');
      else hByte(n);
      i += 2;
      continue;
    }
    if (c === 96) {
      const k = buf.indexOf(96, i + 1);
      if (k !== -1 && k < e && k > i + 1) {
        hLit('<code>'); hEscBuf(buf, i + 1, k); hLit('</code>');
        i = k + 1;
      } else { hByte(96); i++; }
      continue;
    }
    if (c === 42) {
      if (buf[i + 1] === 42) {
        const k = findUnescapedU8(buf, s, e, '**', i + 2);
        if (k !== -1 && k > i + 2) {
          hLit('<strong>'); tf_inlineU8(buf, i + 2, k, env); hLit('</strong>');
          i = k + 2;
        } else { hLit('**'); i += 2; }
        continue;
      }
      const k = findSingleStarU8(buf, s, e, i + 1);
      if (k !== -1 && k > i + 1) {
        hLit('<em>'); tf_inlineU8(buf, i + 1, k, env); hLit('</em>');
        i = k + 1;
      } else { hByte(42); i++; }
      continue;
    }
    if (c === 91) {
      const k = findUnescapedU8(buf, s, e, ']', i + 1);
      let t = -1;
      if (k !== -1 && buf[k + 1] === 40) {
        for (let q = k + 2; q < e; q++) { if (buf[q] === 41) { t = q; break; } }
      }
      const targetS = t === -1 ? -1 : k + 2, targetE = t === -1 ? -1 : t;
      if (t !== -1 && targetE > targetS && !hasWsU8(buf, targetS, targetE)) {
        const target = buf.toString('utf8', targetS, targetE);
        const href = env.link(target);
        hLit('<a href="'); hEscStr(href); hLit('">');
        tf_inlineU8(buf, i + 1, k, env);
        hLit('</a>');
        i = t + 1;
        continue;
      }
      hByte(91); i++;
      continue;
    }
    hByte(c); i++;
  }
}

// Write a JS string into the HTML arena with HTML escaping.
function hEscStr(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 38) hLit('&amp;');
    else if (c === 60) hLit('&lt;');
    else if (c === 62) hLit('&gt;');
    else if (c === 34) hLit('&quot;');
    else if (c === 39) hLit('&#39;');
    else if (c < 128) hByte(c);
    else {
      // Non-ASCII: encode as UTF-8.
      const buf = Buffer.from(str[i], 'utf8');
      for (let k = 0; k < buf.length; k++) hByte(buf[k]);
    }
  }
}

// Line helpers (byte ranges, no allocation).
function isBlankU8(s, e) {
  for (let i = s; i < e; i++) if (u[i] !== 32 && u[i] !== 9) return false;
  return true;
}
// Trim spaces/tabs at either end; returns [s,e).
function trimLineU8(s, e) {
  while (s < e && (u[s] === 32 || u[s] === 9)) s++;
  while (e > s && (u[e - 1] === 32 || u[e - 1] === 9)) e--;
  return [s, e];
}
// MD_FENCE_OPEN: ```lang[ \t]*$ ; returns lang range or null.
function fenceOpenU8(s, e) {
  if (e - s < 3 || u[s] !== 96 || u[s + 1] !== 96 || u[s + 2] !== 96) return null;
  let i = s + 3;
  while (i < e) {
    const c = u[i];
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langS = s + 3, langE = i;
  while (i < e && (u[i] === 32 || u[i] === 9)) i++;
  if (i !== e) return null;
  return [langS, langE];
}
function fenceCloseU8(s, e) {
  if (e - s < 3 || u[s] !== 96 || u[s + 1] !== 96 || u[s + 2] !== 96) return false;
  let i = s + 3;
  while (i < e && (u[i] === 32 || u[i] === 9)) i++;
  return i === e;
}
// MD_HEADING: ^(#{1,6})[ \t]+(.*?)[ \t]*$ with non-empty text.
function headingOfU8(s, e) {
  let d = 0;
  while (d < 6 && s + d < e && u[s + d] === 35) d++;
  if (d === 0) return null;
  let i = s + d;
  if (i >= e || (u[i] !== 32 && u[i] !== 9)) return null;
  while (i < e && (u[i] === 32 || u[i] === 9)) i++;
  let te = e;
  while (te > i && (u[te - 1] === 32 || u[te - 1] === 9)) te--;
  if (te === i) return null;
  return { depth: d, textS: i, textE: te };
}
function hrU8(s, e) {
  if (e - s < 3) return false;
  const dash = u[s] === 45 && u[s + 1] === 45 && u[s + 2] === 45;
  const star = u[s] === 42 && u[s + 1] === 42 && u[s + 2] === 42;
  if (!dash && !star) return false;
  let i = s + 3;
  while (i < e && (u[i] === 32 || u[i] === 9)) i++;
  return i === e;
}
// MD_BULLET: ^[-*] (.*)$ ; returns text range or null.
function bulletU8(s, e) {
  if (e - s < 2 || (u[s] !== 45 && u[s] !== 42) || u[s + 1] !== 32) return null;
  return [s + 2, e];
}
// MD_ORDERED: ^(\d{1,9})\. (.*)$ ; returns {num, textS, textE} or null.
function orderedU8(s, e) {
  let i = s, nd = 0;
  while (i < e && u[i] >= 48 && u[i] <= 57 && nd < 9) { i++; nd++; }
  if (nd === 0) return null;
  if (i >= e || u[i] !== 46) return null;
  i++;
  if (i >= e || u[i] !== 32) return null;
  let num = 0;
  for (let j = s; j < s + nd; j++) num = num * 10 + (u[j] - 48);
  return { num, textS: i + 1, textE: e };
}
// MD_CONTINUED: ^ {2,}\S — caller guarantees first byte is a space.
function continuedU8(s, e) {
  let i = s;
  while (i < e && u[i] === 32) i++;
  if (i - s < 2) return false;
  if (i >= e) return false;
  const c = u[i];
  if (c === 32 || (c >= 9 && c <= 13)) return false;
  if (c < 128) return true;
  // Non-ASCII first char: decode and check the Unicode whitespace set.
  let cp = 0;
  if (c >= 0xC2 && c < 0xE0 && i + 1 < e) cp = ((c & 0x1F) << 6) | (u[i + 1] & 0x3F);
  else if (c >= 0xE0 && c < 0xF0 && i + 2 < e) cp = ((c & 0x0F) << 12) | ((u[i + 1] & 0x3F) << 6) | (u[i + 2] & 0x3F);
  else if (c >= 0xF0 && i + 3 < e) cp = ((c & 0x07) << 18) | ((u[i + 1] & 0x3F) << 12) | ((u[i + 2] & 0x3F) << 6) | (u[i + 3] & 0x3F);
  else cp = 0xFFFD;
  return !(cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0xFEFF);
}
// Whether a line ends a paragraph.
function endsParagraphU8(s, e, ids) {
  if (s === e) return true;
  const c = u[s];
  if (c === 32 || c === 9) return isBlankU8(s, e);
  if (c === 96) return fenceOpenU8(s, e) !== null;
  if (c === 35) return headingOfU8(s, e) !== null;
  if (c === 45 || c === 42) return hrU8(s, e);
  return false;
}

// Render one source's body (bytes [bodyOff,bodyEnd)) to HTML in the HTML
// arena. Sets src.htmlOff/htmlLen, src.excerptOff/excerptLen, src.toc.
function renderMdU8(src, env) {
  const bS = src.bodyOff, bE = src.bodyEnd;
  const htmlStart = _htmlOff;
  const ids = new Set();
  const toc = [];
  let excerptOff = -1, excerptLen = 0;
  // Line iterator: lines are [ls,le); a trailing '\n' yields a final ''.
  let ls = bS;
  while (ls <= bE) {
    let le = u.indexOf(10, ls);
    if (le === -1 || le > bE) le = bE;
    const lineS = ls, lineE = le;
    const nextLs = le + 1;
    const done = le === bE;
    const c0 = lineS < lineE ? u[lineS] : -1;
    if (lineS === lineE || c0 === 32 || c0 === 9) {
      if (isBlankU8(lineS, lineE)) { ls = nextLs; if (done) break; continue; }
      // Non-blank space/tab line: falls through to list/paragraph below.
    } else if (c0 === 96) {
      const fence = fenceOpenU8(lineS, lineE);
      if (fence !== null) {
        // Collect body lines until a closing fence.
        let bl = nextLs;
        const bodyLines = [];
        while (bl <= bE) {
          let be = u.indexOf(10, bl);
          if (be === -1 || be > bE) be = bE;
          const bc0 = bl < be ? u[bl] : -1;
          if (bc0 === 96 && fenceCloseU8(bl, be)) break;
          bodyLines.push([bl, be]);
          if (be === bE) { bl = bE + 1; break; }
          bl = be + 1;
        }
        // Consume the closing fence line (or run past the end).
        let cl = bl;
        if (cl <= bE) {
          let ce = u.indexOf(10, cl);
          if (ce === -1 || ce > bE) ce = bE;
          ls = ce + 1;
          if (ce === bE) { /* fall out below */ }
        } else ls = bl;
        hLit('<pre><code');
        if (fence[1] > fence[0]) { hLit(' class="language-'); hEscU8(fence[0], fence[1]); hByte(34); }
        hByte(62);
        if (bodyLines.length !== 0) {
          for (let k = 0; k < bodyLines.length; k++) {
            if (k > 0) hByte(10);
            hEscU8(bodyLines[k][0], bodyLines[k][1]);
          }
          hByte(10);
        }
        hLit('</code></pre>');
        hByte(10);
        if (ls > bE) break;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOfU8(lineS, lineE);
      if (hd !== null) {
        const slug = slugifyU8(hd.textS, hd.textE);
        const id = uniqueSlugU8(slug.o, slug.l, ids);
        hLit('<h'); hByte(48 + hd.depth); hLit(' id="'); hCopyArena(id.o, id.l); hLit('">');
        const htmlStart2 = _htmlOff;
        tf_inlineU8(_rawBuf, hd.textS, hd.textE, env);
        const htmlEnd2 = _htmlOff;
        hLit('</h'); hByte(48 + hd.depth); hByte(62); hByte(10);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, idOff: id.o, idLen: id.l, htmlOff: htmlStart2, htmlLen: htmlEnd2 - htmlStart2 });
        ls = nextLs; if (done) break; continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (hrU8(lineS, lineE)) { hLit('<hr>'); hByte(10); ls = nextLs; if (done) break; continue; }
    } else if (c0 === 62) {
      // Quote: consecutive lines starting with '>'.
      const qLines = [];
      let ql = lineS;
      while (ql <= bE) {
        let qe = u.indexOf(10, ql);
        if (qe === -1 || qe > bE) qe = bE;
        if (ql >= qe || u[ql] !== 62) break;
        // Strip '>' + one optional space.
        let qs = ql + 1;
        if (qs < qe && u[qs] === 32) qs++;
        qLines.push([qs, qe]);
        if (qe === bE) { ql = bE + 1; break; }
        ql = qe + 1;
      }
      ls = ql;
      const parts = [];
      for (const [ps, pe] of qLines) {
        const [ts, te] = trimLineU8(ps, pe);
        if (ts < te) parts.push([ts, te]);
      }
      if (parts.length === 0) { hLit('<blockquote>\n</blockquote>'); hByte(10); }
      else {
        hLit('<blockquote>\n<p>');
        inlineLinesU8(parts, env);
        hLit('</p>\n</blockquote>'); hByte(10);
      }
      if (ls > bE) break;
      continue;
    }
    // List or paragraph.
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bul = bulletU8(lineS, lineE);
      const ord = bul === null ? orderedU8(lineS, lineE) : null;
      if (bul !== null || ord !== null) {
        const isOrdered = ord !== null;
        const items = [];
        let il = lineS;
        while (il <= bE) {
          let ie = u.indexOf(10, il);
          if (ie === -1 || ie > bE) ie = bE;
          const m = isOrdered ? orderedU8(il, ie) : bulletU8(il, ie);
          if (m !== null) {
            const [ts, te] = trimLineU8(isOrdered ? m.textS : m[0], isOrdered ? m.textE : m[1]);
            items.push([[ts, te]]);
            if (ie === bE) { il = bE + 1; break; }
            il = ie + 1;
          } else if (il < ie && u[il] === 32 && continuedU8(il, ie)) {
            const [ts, te] = trimLineU8(il, ie);
            items[items.length - 1].push([ts, te]);
            if (ie === bE) { il = bE + 1; break; }
            il = ie + 1;
          } else break;
        }
        ls = il;
        const start = isOrdered ? ord.num : 1;
        if (isOrdered && start !== 1) { hLit('<ol start="'); hLit(String(start)); hLit('">'); }
        else hLit(isOrdered ? '<ol>' : '<ul>');
        hByte(10);
        for (const parts of items) {
          hLit('<li>');
          inlineLinesU8(parts, env);
          hLit('</li>'); hByte(10);
        }
        hLit(isOrdered ? '</ol>' : '</ul>'); hByte(10);
        if (ls > bE) break;
        continue;
      }
    }
    // Paragraph.
    const [ps, pe] = trimLineU8(lineS, lineE);
    const paraLines = [[ps, pe]];
    let pl = nextLs;
    while (pl <= bE) {
      let pe2 = u.indexOf(10, pl);
      if (pe2 === -1 || pe2 > bE) pe2 = bE;
      if (endsParagraphU8(pl, pe2)) break;
      const [ts, te] = trimLineU8(pl, pe2);
      paraLines.push([ts, te]);
      if (pe2 === bE) { pl = bE + 1; break; }
      pl = pe2 + 1;
    }
    ls = pl;
    hLit('<p>');
    const exStart = _htmlOff;
    inlineLinesU8(paraLines, env);
    if (excerptOff === -1) { excerptOff = exStart; excerptLen = _htmlOff - exStart; }
    hLit('</p>'); hByte(10);
    if (ls > bE) break;
  }
  src.htmlOff = htmlStart;
  src.htmlLen = _htmlOff - htmlStart;
  src.excerptOff = excerptOff === -1 ? htmlStart : excerptOff;
  src.excerptLen = excerptOff === -1 ? 0 : excerptLen;
  src.toc = toc;
}

// ---------------------------------------------------------------- chunk 4: template compiler + VM

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

// Path interning: every {{path}} / {% for/if path %} becomes a small id.
// pathFirst[id] = first segment, pathRest[id] = the rest ('' when none).
const pathIds = new Map();
const pathList = [];
const pathFirst = [];
const pathRest = [];
const pathRestParts = []; // pre-split pathRest (null when pathRest is '')
function internPath(text) {
  let id = pathIds.get(text);
  if (id !== undefined) return id;
  id = pathList.length;
  pathIds.set(text, id);
  pathList.push(text);
  const dot = text.indexOf('.');
  pathFirst.push(dot === -1 ? text : text.slice(0, dot));
  pathRest.push(dot === -1 ? '' : text.slice(dot + 1));
  pathRestParts.push(dot === -1 ? null : text.slice(dot + 1).split('.'));
  return id;
}
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return internPath(text);
}

// Tokenize a template source (JS string) — same rules as the fallback's
// tokenize: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken
// with it. Returns tokens [{t:'text',text}|{t:'var'|'raw',pid}|{t:'tag',tag}].
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', pid: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Write a JS string into the string arena with JSON escaping (for template
// literals, which the VM copies verbatim into the output). Lone surrogates
// become \uXXXX; valid pairs become their UTF-8 bytes.
function strWriteJsonEsc(str) {
  let o = strEnsure(str.length * 6 + 8);
  const start = o;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 34) { _strU8[o++] = 92; _strU8[o++] = 34; }
    else if (c === 92) { _strU8[o++] = 92; _strU8[o++] = 92; }
    else if (c === 10) { _strU8[o++] = 92; _strU8[o++] = 110; }
    else if (c === 13) { _strU8[o++] = 92; _strU8[o++] = 114; }
    else if (c === 9) { _strU8[o++] = 92; _strU8[o++] = 116; }
    else if (c === 8) { _strU8[o++] = 92; _strU8[o++] = 98; }
    else if (c === 12) { _strU8[o++] = 92; _strU8[o++] = 102; }
    else if (c < 32) {
      const h = '0123456789abcdef';
      _strU8[o++] = 92; _strU8[o++] = 117; _strU8[o++] = 48; _strU8[o++] = 48;
      _strU8[o++] = h.charCodeAt((c >> 4) & 0xF);
      _strU8[o++] = h.charCodeAt(c & 0xF);
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
      const cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(i + 1) - 0xDC00);
      _strU8[o++] = 0xF0 | (cp >> 18); _strU8[o++] = 0x80 | ((cp >> 12) & 0x3F);
      _strU8[o++] = 0x80 | ((cp >> 6) & 0x3F); _strU8[o++] = 0x80 | (cp & 0x3F);
      i++;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      // Lone surrogate -> \uXXXX.
      _strU8[o++] = 92; _strU8[o++] = 117;
      const h = '0123456789abcdef';
      _strU8[o++] = h.charCodeAt((c >> 12) & 0xF); _strU8[o++] = h.charCodeAt((c >> 8) & 0xF);
      _strU8[o++] = h.charCodeAt((c >> 4) & 0xF); _strU8[o++] = h.charCodeAt(c & 0xF);
    } else if (c < 128) _strU8[o++] = c;
    else if (c < 0x800) { _strU8[o++] = 0xC0 | (c >> 6); _strU8[o++] = 0x80 | (c & 0x3F); }
    else { _strU8[o++] = 0xE0 | (c >> 12); _strU8[o++] = 0x80 | ((c >> 6) & 0x3F); _strU8[o++] = 0x80 | (c & 0x3F); }
  }
  _strOff = o;
  return { o: start, l: o - start };
}

// Op layout (4 ints): [op, a, b, c].
//   0 LIT  [0, arenaOff, len, 0]          literal, pre-JSON-escaped
//   1 VAR  [1, pathId, 0=esc|1=raw, 0]    slot value, escaped or raw
//   2 IF   [2, pathId, not, targetIdx]    jump to targetIdx when the
//                                          branch is NOT taken
//   3 JMP  [3, targetIdx, 0, 0]
//   4 FOR  [4, arrayPathId, loopMetaIdx, bodyEndIdx]
//   5 INC  [5, templateIdx, 0, 0]        include (templateIdx into the
//                                          case's compiled list)
const OP_LIT = 0, OP_VAR = 1, OP_IF = 2, OP_JMP = 3, OP_FOR = 4, OP_INC = 5;

// Compile one template's source into ops. Throws TemplateError.
// Returns { ops: Int32Array, fors: [{opIdx, varName, fieldIds, loopIds}] }.
// `includeNames` collects include target names (resolved after all compile).
function compileTemplate(name, src) {
  const tokens = tokenizeTpl(name, src);
  const ops = [];
  const fors = [];
  const incNames = [];
  const stack = []; // frames: {kind:'for'|'if', opIdx, elseJmp}
  const emit = (op, a, b, c) => { ops.push(op, a, b, c); return (ops.length >> 2) - 1; };
  for (const tok of tokens) {
    if (tok.t === 'text') {
      const lit = strWriteJsonEsc(tok.text);
      emit(OP_LIT, lit.o, lit.l, 0);
    } else if (tok.t === 'var' || tok.t === 'raw') {
      emit(OP_VAR, tok.pid, tok.t === 'raw' ? 1 : 0, 0);
    } else {
      const tag = tok.tag;
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const varName = m[1];
        const arrPid = pathOf(name, m[2]);
        const opIdx = emit(OP_FOR, arrPid, fors.length, 0);
        fors.push({ opIdx, varName, fieldIds: null, loopIds: null });
        stack.push({ kind: 'for', opIdx });
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const not = m[1] !== undefined ? 1 : 0;
        const pid = pathOf(name, m[2]);
        const opIdx = emit(OP_IF, pid, not, 0);
        stack.push({ kind: 'if', opIdx, elseJmp: -1 });
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.kind !== 'if' || top.elseJmp !== -1) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        // Jump over the else-branch at the end of the then-branch.
        const jmpIdx = emit(OP_JMP, 0, 0, 0);
        top.elseJmp = jmpIdx;
        // The IF now jumps to the else-branch start (the next op).
        ops[(top.opIdx << 2) + 3] = ops.length >> 2;
      } else if (tag === 'endfor' || tag === 'endif') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const endIdx = ops.length >> 2;
        if (tag === 'endif') {
          if (top.elseJmp !== -1) ops[(top.elseJmp << 2) + 1] = endIdx;
          else ops[(top.opIdx << 2) + 3] = endIdx;
        } else {
          ops[(top.opIdx << 2) + 3] = endIdx;
        }
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
        incNames.push(m[1]);
        emit(OP_INC, incNames.length - 1, 0, 0);
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 0) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  // Resolve each FOR's affected slot ids: every interned path whose first
  // segment is the loop var, plus loop.index/first/last/length.
  const loopPids = ['loop.index', 'loop.first', 'loop.last', 'loop.length'].map((p) => internPath(p));
  for (const f of fors) {
    const fieldIds = [];
    for (let pid = 0; pid < pathList.length; pid++) {
      if (pathFirst[pid] === f.varName) fieldIds.push(pid);
    }
    f.fieldIds = fieldIds;
    f.loopIds = loopPids;
    f.varPid = internPath(f.varName);
  }
  return { ops: Int32Array.from(ops), fors, incNames };
}

// ---------------------------------------------------------------- VM slot table

// Slot kinds: 0 missing/null, 1 bytes (string arena), 2 number, 3 bool,
// 4 array, 6 object (truthy, textOf ''), 7 bytes (HTML arena).
function newSlots(n) {
  return {
    t: new Int8Array(n),
    a: new Int32Array(n),
    b: new Int32Array(n),
    n: new Float64Array(n),
    arr: new Array(n),
  };
}
function setBytesSlot(sl, id, off, len, htmlArena) {
  sl.t[id] = htmlArena ? 7 : 1; sl.a[id] = off; sl.b[id] = len;
}
function setNumSlot(sl, id, v) { sl.t[id] = 2; sl.n[id] = v; }
function setBoolSlot(sl, id, v) { sl.t[id] = 3; sl.n[id] = v ? 1 : 0; }
function setArrSlot(sl, id, arr) { sl.t[id] = 4; sl.arr[id] = arr; }
function setObjSlot(sl, id) { sl.t[id] = 6; }
function clearSlot(sl, id) { sl.t[id] = 0; sl.arr[id] = undefined; }

// Fill every interned path slot whose first segment is `firstSeg` from an
// object (the root scope's page/pager/tag). Mirrors the fallback's lookup
// walking the object for dotted paths.
function fillObjectSlots(sl, obj, firstSeg) {
  if (obj === null || obj === undefined) return;
  for (let pid = 0; pid < pathList.length; pid++) {
    if (pathFirst[pid] !== firstSeg) continue;
    if (pathRest[pid] === '') continue; // the object itself: set by caller
    setSlotFromValue(sl, pid, getField(obj, pathRestParts[pid]));
  }
}
function setSlotFromValue(sl, id, v) {
  if (v === null || v === undefined) { sl.t[id] = 0; return; }
  if (typeof v === 'number') { sl.t[id] = 2; sl.n[id] = v; return; }
  if (typeof v === 'boolean') { sl.t[id] = 3; sl.n[id] = v ? 1 : 0; return; }
  if (Array.isArray(v)) { sl.t[id] = 4; sl.arr[id] = v; return; }
  if (typeof v === 'object') {
    if (v.o !== undefined) { sl.t[id] = v.h ? 7 : 1; sl.a[id] = v.o; sl.b[id] = v.l; return; }
    sl.t[id] = 6; return;
  }
  sl.t[id] = 0;
}

// Walk a dotted field path on an element object. `parts` is the pre-split
// pathRest (null = the element itself); see internPath/pathRestParts.
function getField(el, parts) {
  if (parts === null) return el;
  let v = el;
  for (let k = 0; k < parts.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[parts[k]];
  }
  return v;
}

function slotTruthy(sl, id) {
  const t = sl.t[id];
  if (t === 0) return false;
  if (t === 1 || t === 7) return sl.b[id] > 0;
  if (t === 2 || t === 3) return sl.n[id] !== 0;
  if (t === 4) return sl.arr[id].length > 0;
  return true; // object
}

// textOf for a slot value, as a JS string (slow path: arrays / objects).
function slotTextOf(sl, id) {
  const t = sl.t[id];
  if (t === 0) return '';
  if (t === 1) return _strBuf.toString('utf8', sl.a[id], sl.a[id] + sl.b[id]);
  if (t === 7) return _htmlBuf.toString('utf8', sl.a[id], sl.a[id] + sl.b[id]);
  if (t === 2) return String(sl.n[id]);
  if (t === 3) return sl.n[id] ? 'true' : 'false';
  if (t === 4) {
    const arr = sl.arr[id];
    let out = '';
    for (let k = 0; k < arr.length; k++) {
      if (k > 0) out += ', ';
      out += textOfValue(arr[k]);
    }
    return out;
  }
  return '';
}
function textOfValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfValue).join(', ');
  return '';
}

// ---------------------------------------------------------------- output copy kernels (write JSON-escaped bytes)

// Ensure room in the output arena for `need` more bytes.
function outEnsure(need) {
  if (_outOff + need > OUT_CAP) outFlush();
  return _outOff;
}

// Copy bytes [off,off+len) from `buf` with HTML escaping AND JSON escaping
// (the {{ }} path).
function outEscBuf(buf, off, len) {
  let o = outEnsure(len * 6 + 8);
  const end = off + len;
  for (let i = off; i < end; i++) {
    const c = buf[i];
    if (c === 38) { _outU8[o++] = 38; _outU8[o++] = 97; _outU8[o++] = 109; _outU8[o++] = 112; _outU8[o++] = 59; }
    else if (c === 60) { _outU8[o++] = 38; _outU8[o++] = 108; _outU8[o++] = 116; _outU8[o++] = 59; }
    else if (c === 62) { _outU8[o++] = 38; _outU8[o++] = 103; _outU8[o++] = 116; _outU8[o++] = 59; }
    else if (c === 34) { _outU8[o++] = 38; _outU8[o++] = 113; _outU8[o++] = 117; _outU8[o++] = 111; _outU8[o++] = 116; _outU8[o++] = 59; }
    else if (c === 39) { _outU8[o++] = 38; _outU8[o++] = 35; _outU8[o++] = 51; _outU8[o++] = 57; _outU8[o++] = 59; }
    else if (c === 92) { _outU8[o++] = 92; _outU8[o++] = 92; }
    else if (c === 10) { _outU8[o++] = 92; _outU8[o++] = 110; }
    else if (c === 13) { _outU8[o++] = 92; _outU8[o++] = 114; }
    else if (c === 9) { _outU8[o++] = 92; _outU8[o++] = 116; }
    else if (c < 32) {
      _outU8[o++] = 92; _outU8[o++] = 117; _outU8[o++] = 48; _outU8[o++] = 48;
      const h = '0123456789abcdef';
      _outU8[o++] = h.charCodeAt((c >> 4) & 0xF); _outU8[o++] = h.charCodeAt(c & 0xF);
    } else _outU8[o++] = c;
    if (o > OUT_CAP - 16) { _outOff = o; o = outEnsure(len); }
  }
  _outOff = o;
}

// Copy bytes [off,off+len) from `buf` with JSON escaping only ({{{ }}}).
// Bulk version: clean runs (no byte in {", \, <32}) are copied with a
// single set() instead of one store per byte; only special bytes branch.
function outRawBuf(buf, off, len) {
  let o = outEnsure(len * 6 + 8);
  const end = off + len;
  let i = off;
  while (i < end) {
    let j = i;
    while (j < end) {
      const c = buf[j];
      if (c === 34 || c === 92 || c < 32) break;
      j++;
    }
    if (j > i) {
      if (o + (j - i) > OUT_CAP - 16) { _outOff = o; o = outEnsure(j - i); }
      _outU8.set(buf.subarray(i, j), o);
      o += (j - i);
    }
    if (j >= end) break;
    const c = buf[j];
    if (o > OUT_CAP - 16) { _outOff = o; o = outEnsure(16); }
    if (c === 34) { _outU8[o++] = 92; _outU8[o++] = 34; }
    else if (c === 92) { _outU8[o++] = 92; _outU8[o++] = 92; }
    else if (c === 10) { _outU8[o++] = 92; _outU8[o++] = 110; }
    else if (c === 13) { _outU8[o++] = 92; _outU8[o++] = 114; }
    else if (c === 9) { _outU8[o++] = 92; _outU8[o++] = 116; }
    else if (c === 8) { _outU8[o++] = 92; _outU8[o++] = 98; }
    else if (c === 12) { _outU8[o++] = 92; _outU8[o++] = 102; }
    else {
      _outU8[o++] = 92; _outU8[o++] = 117; _outU8[o++] = 48; _outU8[o++] = 48;
      const h = '0123456789abcdef';
      _outU8[o++] = h.charCodeAt((c >> 4) & 0xF); _outU8[o++] = h.charCodeAt(c & 0xF);
    }
    i = j + 1;
  }
  _outOff = o;
}

// Write a JS string with HTML + JSON escaping (slow path).
function outEscStr(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 38) outAscii('&amp;');
    else if (c === 60) outAscii('&lt;');
    else if (c === 62) outAscii('&gt;');
    else if (c === 34) outAscii('&quot;');
    else if (c === 39) outAscii('&#39;');
    else if (c === 92) outAscii('\\\\');
    else if (c === 10) outAscii('\\n');
    else if (c === 13) outAscii('\\r');
    else if (c === 9) outAscii('\\t');
    else if (c < 32) outAscii('\\u00' + '0123456789abcdef'[(c >> 4) & 0xF] + '0123456789abcdef'[c & 0xF]);
    else if (c < 128) outByte(c);
    else {
      const buf = Buffer.from(str[i], 'utf8');
      for (let k = 0; k < buf.length; k++) outByte(buf[k]);
    }
  }
}

// Write a JS string with JSON escaping only (slow path).
function outRawStr(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 34) outAscii('\\"');
    else if (c === 92) outAscii('\\\\');
    else if (c === 10) outAscii('\\n');
    else if (c === 13) outAscii('\\r');
    else if (c === 9) outAscii('\\t');
    else if (c === 8) outAscii('\\b');
    else if (c === 12) outAscii('\\f');
    else if (c < 32) outAscii('\\u00' + '0123456789abcdef'[(c >> 4) & 0xF] + '0123456789abcdef'[c & 0xF]);
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
      const cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(i + 1) - 0xDC00);
      const buf = Buffer.from(String.fromCodePoint(cp), 'utf8');
      for (let k = 0; k < buf.length; k++) outByte(buf[k]);
      i++;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      outAscii('\\u' + '0123456789abcdef'[(c >> 12) & 0xF] + '0123456789abcdef'[(c >> 8) & 0xF] + '0123456789abcdef'[(c >> 4) & 0xF] + '0123456789abcdef'[c & 0xF]);
    } else if (c < 128) outByte(c);
    else {
      const buf = Buffer.from(str[i], 'utf8');
      for (let k = 0; k < buf.length; k++) outByte(buf[k]);
    }
  }
}

// Emit one slot value: raw=0 -> {{ }} (HTML+JSON), raw=1 -> {{{ }}} (JSON).
function emitSlot(sl, id, raw) {
  const t = sl.t[id];
  if (t === 0) return;
  if (t === 1) { if (raw) outRawBuf(_strU8, sl.a[id], sl.b[id]); else outEscBuf(_strU8, sl.a[id], sl.b[id]); return; }
  if (t === 7) { if (raw) outRawBuf(_htmlU8, sl.a[id], sl.b[id]); else outEscBuf(_htmlU8, sl.a[id], sl.b[id]); return; }
  if (t === 2) { outAscii(String(sl.n[id])); return; }
  if (t === 3) { outAscii(sl.n[id] ? 'true' : 'false'); return; }
  if (t === 4 || t === 6) {
    const s = slotTextOf(sl, id);
    if (raw) outRawStr(s); else outEscStr(s);
    return;
  }
}

// ---------------------------------------------------------------- X1: static-include cache
// Pre-rendered bytes of case-constant templates: a template whose output
// depends only on site/tags/recent (fixed for the whole case) renders
// identically on every page, so the first OP_INC execution is captured
// into the static arena and later OP_INCs replay the bytes with outBytes.
// _curIsConst/_curConstCache are set per case in runStreamCase; the static
// arena is never flushed (exactly OUT_CAP so the output bounds logic stays
// valid while it is swapped in as the output buffer during capture).
let _staticBuf = Buffer.allocUnsafe(1 << 20);
let _staticU8 = new Uint8Array(_staticBuf.buffer, _staticBuf.byteOffset, _staticBuf.byteLength);
let _staticOff = 0;
let _curIsConst = null;   // Array<boolean>, indexed by tplList index
let _curConstCache = null; // Array<{o,l}|null|undefined>, indexed by tplList index
const X1_OFF = process.env.MAKEFUN_X1_OFF === '1';
const X1_DEBUG = process.env.MAKEFUN_X1_DEBUG === '1';
let _x1Caps = 0, _x1CapBytes = 0, _x1Reps = 0, _x1RepBytes = 0;
let _x1TplNames = null;

// Execute ops[from..to) in `ctx` ({slots, templates, loopStack}).
// `templates` maps name -> {ops, fors} (compiled) or undefined.
function execVm(ops, from, to, ctx, depth) {
  const sl = ctx.slots;
  let pc = from;
  while (pc < to) {
    const base = pc << 2;
    const op = ops[base];
    if (op === OP_LIT) {
      outBytes(_strBuf, ops[base + 1], ops[base + 1] + ops[base + 2]);
      pc++;
    } else if (op === OP_VAR) {
      emitSlot(sl, ops[base + 1], ops[base + 2]);
      pc++;
    } else if (op === OP_IF) {
      const taken = slotTruthy(sl, ops[base + 1]) !== (ops[base + 2] === 1);
      pc = taken ? pc + 1 : ops[base + 3];
    } else if (op === OP_JMP) {
      pc = ops[base + 1];
    } else if (op === OP_FOR) {
      const arrPid = ops[base + 1];
      const metaIdx = ops[base + 2];
      const bodyEnd = ops[base + 3];
      const meta = ctx.fors[metaIdx];
      const arr = sl.t[arrPid] === 4 ? sl.arr[arrPid] : null;
      if (arr === null || arr.length === 0) { pc = bodyEnd; continue; }
      // Save the slots this loop writes.
      const saved = [];
      const save = (id) => saved.push([id, sl.t[id], sl.a[id], sl.b[id], sl.n[id], sl.arr[id]]);
      for (const id of meta.fieldIds) save(id);
      save(meta.varPid);
      for (const id of meta.loopIds) save(id);
      const loopIndexId = meta.loopIds[0], loopFirstId = meta.loopIds[1], loopLastId = meta.loopIds[2], loopLenId = meta.loopIds[3];
      setNumSlot(sl, loopLenId, arr.length);
      for (let k = 0; k < arr.length; k++) {
        const el = arr[k];
        setSlotFromValue(sl, meta.varPid, el);
        for (const id of meta.fieldIds) {
          setSlotFromValue(sl, id, getField(el, pathRestParts[id]));
        }
        setNumSlot(sl, loopIndexId, k + 1);
        setBoolSlot(sl, loopFirstId, k === 0);
        setBoolSlot(sl, loopLastId, k === arr.length - 1);
        execVm(ops, pc + 1, bodyEnd, ctx, depth);
      }
      for (const [id, t, a, b, n, ar] of saved) {
        sl.t[id] = t; sl.a[id] = a; sl.b[id] = b; sl.n[id] = n; sl.arr[id] = ar;
      }
      pc = bodyEnd;
    } else if (op === OP_INC) {
      const ci = ops[base + 1];
      const target = ctx.templates[ci];
      if (target !== undefined && depth < 8) {
        if (_curIsConst !== null && !X1_OFF && _curIsConst[ci]) {
          const cc = _curConstCache[ci];
          if (cc !== undefined) {
            if (cc !== null) { outBytes(_staticBuf, cc.o, cc.o + cc.l); _x1Reps++; _x1RepBytes += cc.l; }
          } else if ((_outBuf === _staticBuf ? _outOff : _staticOff) + 65536 <= (1 << 20)) {
            if (_outBuf === _staticBuf) {
              // Already capturing (nested constant include): append in place.
              // The bytes join the outer capture's stream at the current
              // position; the entry records exactly this slice. Do NOT
              // touch _staticOff here: the outer capture owns the region
              // and sets the high-water mark when it finishes.
              const startOff = _outOff;
              execVm(target.ops, 0, target.ops.length >> 2, { slots: sl, templates: ctx.templates, fors: target.fors }, depth + 1);
              const l = _outOff - startOff;
              _curConstCache[ci] = l > 0 ? { o: startOff, l } : null;
              _x1Caps++; _x1CapBytes += l;
              if (X1_DEBUG) console.error(`[x1] capture nested ${_x1TplNames ? _x1TplNames[ci] : ci} l=${l} @${startOff}`);
              // No replay: the bytes are already in the outer capture stream.
            } else {
              // First execution: render into the static arena, cache, replay.
              const savedBuf = _outBuf, savedU8 = _outU8, savedOff = _outOff;
              _outBuf = _staticBuf; _outU8 = _staticU8; _outOff = _staticOff;
              execVm(target.ops, 0, target.ops.length >> 2, { slots: sl, templates: ctx.templates, fors: target.fors }, depth + 1);
              const l = _outOff - _staticOff;
              _curConstCache[ci] = l > 0 ? { o: _staticOff, l } : null;
              _staticOff = _outOff;
              _outBuf = savedBuf; _outU8 = savedU8; _outOff = savedOff;
              _x1Caps++; _x1CapBytes += l;
              if (X1_DEBUG) console.error(`[x1] capture ${_x1TplNames ? _x1TplNames[ci] : ci} l=${l} @${_curConstCache[ci] ? _curConstCache[ci].o : '-'}`);
              if (l > 0) outBytes(_staticBuf, _curConstCache[ci].o, _curConstCache[ci].o + l);
            }
          } else {
            // No room left in the static arena: execute directly, no cache.
            execVm(target.ops, 0, target.ops.length >> 2, { slots: sl, templates: ctx.templates, fors: target.fors }, depth + 1);
          }
        } else {
          execVm(target.ops, 0, target.ops.length >> 2, { slots: sl, templates: ctx.templates, fors: target.fors }, depth + 1);
        }
      }
      pc++;
    } else pc++;
  }
}

// ---------------------------------------------------------------- chunk 5: orchestration, runCli, fallback

let _rawU8 = null; // Uint8Array view of the whole cases.json
let _rawBuf = null; // Buffer of the whole cases.json
let _fallbackRun = null;
function getFallbackRun() {
  if (_fallbackRun === null) _fallbackRun = require('./fallback.cjs').run;
  return _fallbackRun;
}

// Copy bytes [s,e) of `buf` into the string arena; returns {o, l}.
function copyToArena(buf, s, e) {
  const o = strEnsure(e - s + 8);
  _strU8.set(buf.subarray(s, e), o);
  _strOff = o + (e - s);
  return { o, l: e - s };
}
// Write a JS string's UTF-8 bytes into the string arena; returns {o, l}.
function strRangeOf(str) {
  strEnsure(str.length * 3 + 16);
  const o = _strOff;
  const n = _strBuf.utf8Write(str, o);
  _strOff = o + n;
  return { o, l: n };
}

// Whether a JS string holds a lone surrogate (which the byte pipeline
// cannot represent as arena bytes).
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 >= str.length || str.charCodeAt(i + 1) < 0xDC00 || str.charCodeAt(i + 1) > 0xDFFF) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) return true;
  }
  return false;
}

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOfStr = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Normalize CR line ends in place over decoded bytes [off,off+len):
// /\r\n?/ -> '\n' (exactly the fallback's replace). Returns the new length.
function tf_compactCR(off, len) {
  let w = off, r = off;
  const end = off + len;
  while (r < end) {
    const c = u[r];
    if (c === 13) {
      if (r + 1 < end && u[r + 1] === 10) { r++; continue; } // drop \r of \r\n
      u[w++] = 10; r++; // lone \r -> \n
    } else { u[w++] = c; r++; }
  }
  return w - off;
}

// Write one case's answer via the exact fallback (slow path). The input is
// rebuilt from the parsed records (the raw buffer was unescaped in place
// and is no longer valid JSON). The caller already wrote '[' or ','.
function writeFallbackAnswer(inp) {
  const files = inp.files.map((f) => {
    let content;
    if (f.uOff !== -1) content = _rawBuf.utf8Slice(f.uOff, f.uOff + f.uLen);
    else if (f.content !== null && f.content !== undefined) content = f.content;
    else content = JSON.parse(_rawBuf.utf8Slice(f.rawQStart, f.rawQEnd));
    return { path: f.path, content };
  });
  const ans = getFallbackRun()({ site: inp.site, templates: inp.templates, files });
  outUtf8(JSON.stringify(ans));
}

// One case: the full pipeline, streaming the answer object into the output
// arena. Returns nothing.
function runStreamCase(caseRec) {
  const inp = caseRec.input;
  if (!inp || typeof inp !== 'object' || !inp.site || typeof inp.site !== 'object' ||
      !inp.templates || typeof inp.templates !== 'object' || !Array.isArray(inp.files)) {
    throw new Error('exp11: malformed case input');
  }
  u = _rawU8;
  _strOff = _strBase;
  _htmlOff = 0;
  const site = inp.site;
  const base = typeof site.base_url === 'string' ? site.base_url.replace(/\/+$/, '') : '';
  const siteTitle = typeof site.title === 'string' ? site.title : '';
  const recent = typeof site.recent === 'number' ? site.recent : 0;
  const perPage = typeof site.per_page === 'number' && site.per_page > 0 ? site.per_page : 1;
  if (hasLoneSurrogate(siteTitle) || hasLoneSurrogate(base)) { writeFallbackAnswer(inp); return; }

  // ---- compile templates (sorted by name); parse failures go to the report.
  const report = [];
  const templates = {}; // name -> {ops, fors, incIdx}
  const tplNames = Object.keys(inp.templates).sort(byCodeUnits);
  for (const name of tplNames) {
    const src = inp.templates[name];
    if (typeof src !== 'string') continue;
    try {
      const c = compileTemplate(name, src);
      templates[name] = c;
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  // Resolve include names to compiled templates (index into a list).
  const tplList = [];
  const tplIndex = new Map();
  for (const name of tplNames) {
    if (templates[name] !== undefined) { tplIndex.set(name, tplList.length); tplList.push(name); }
  }
  for (const name of tplList) {
    const c = templates[name];
    c.incIdx = c.incNames.map((n) => (tplIndex.has(n) ? tplIndex.get(n) : -1));
    // Rewrite each INC op's operand from the incNames index to the resolved
    // index into ctxTemplates (-1 when the target does not exist / parse).
    const ops = c.ops;
    for (let k = 0; k < ops.length; k += 4) {
      if (ops[k] === OP_INC) ops[k + 1] = c.incIdx[ops[k + 1]];
    }
  }
  const ctxTemplates = tplList.map((n) => templates[n]);

  // Fix up every FOR's fieldIds now that ALL templates are compiled. A
  // path like p.tags can first be interned by an included template that
  // is compiled after the template holding the FOR, so the compile-time
  // fieldIds would miss it and the loop would never fill that slot
  // (the include then sees p.tags as missing). Recomputing here, with the
  // path list complete, is the only correct point.
  for (const name of tplList) {
    for (const f of templates[name].fors) {
      const fieldIds = [];
      for (let pid = 0; pid < pathList.length; pid++) {
        if (pathFirst[pid] === f.varName) fieldIds.push(pid);
      }
      f.fieldIds = fieldIds;
    }
  }

  // ---- X1: case-constant templates (static includes).
  // A template is case-constant iff every value it reads comes from
  // site/tags/recent (fixed for the whole case) or from a FOR variable
  // bound to a case-constant array, AND every template it includes is
  // case-constant. Depth guard: cache only when (longest chain from a
  // render root) + (include height) < 8, so the depth<8 include cutoff
  // can never change the output between executions. Cycles and FOR vars
  // shadowing a case root are treated as non-constant (safe side).
  const tplIsConst = new Array(tplList.length).fill(false);
  {
    const directFree = new Array(tplList.length).fill(false);
    const incLists = new Array(tplList.length);
    for (let ti = 0; ti < tplList.length; ti++) {
      const c = templates[tplList[ti]];
      const ops = c.ops;
      // Pass 1: collect ALL includes (full scan). The freeness scan below
      // early-exits on the first free reference, but the include graph must
      // be complete — a template included only after a free reference in its
      // includer still needs its depth computed.
      const incs = [];
      for (let pc = 0; pc < (ops.length >> 2); pc++) {
        if (ops[pc << 2] === OP_INC) incs.push(ops[(pc << 2) + 1]);
      }
      const scope = []; // {name, isConst, end}
      let free = false;
      const boundConst = (root) => {
        for (let i = scope.length - 1; i >= 0; i--) {
          if (scope[i].name === root) return scope[i].isConst;
        }
        return null; // unbound
      };
      for (let pc = 0; pc < (ops.length >> 2) && !free; pc++) {
        while (scope.length > 0 && pc >= scope[scope.length - 1].end) scope.pop();
        const base = pc << 2;
        const op = ops[base];
        if (op === OP_VAR || op === OP_IF) {
          const root = pathFirst[ops[base + 1]];
          if (root === 'loop') continue;
          const b = boundConst(root);
          if (b === null) { if (root !== 'site' && root !== 'tags' && root !== 'recent') free = true; }
          else if (!b) free = true;
        } else if (op === OP_FOR) {
          const meta = c.fors[ops[base + 2]];
          if (meta.varName === 'loop' || meta.varName === 'site' || meta.varName === 'tags' || meta.varName === 'recent' || meta.varName === 'page' || meta.varName === 'posts' || meta.varName === 'pager' || meta.varName === 'tag') { free = true; continue; }
          const arrRoot = pathFirst[ops[base + 1]];
          let arrConst;
          if (arrRoot === 'site' || arrRoot === 'tags' || arrRoot === 'recent') arrConst = true;
          else if (arrRoot === 'loop') arrConst = false;
          else arrConst = boundConst(arrRoot) === true;
          scope.push({ name: meta.varName, isConst: arrConst, end: ops[base + 3] });
        }
      }
      directFree[ti] = free;
      incLists[ti] = incs;
    }
    // Include height (longest chain below this template); cycle -> 99.
    const height = new Array(tplList.length).fill(0);
    const hState = new Array(tplList.length).fill(0);
    const heightOf = (ti) => {
      if (hState[ti] === 2) return height[ti];
      if (hState[ti] === 1) return 99;
      hState[ti] = 1;
      let h = 0;
      for (const ci of incLists[ti]) {
        if (ci === -1) continue;
        const ch = heightOf(ci);
        if (ch >= 99) { h = 99; break; }
        if (ch + 1 > h) h = ch + 1;
      }
      hState[ti] = 2;
      height[ti] = h;
      return h;
    };
    for (let ti = 0; ti < tplList.length; ti++) heightOf(ti);
    // Longest chain from a render root to each template (reverse DFS).
    const includers = new Array(tplList.length).fill(null).map(() => []);
    for (let ti = 0; ti < tplList.length; ti++) {
      for (const ci of incLists[ti]) {
        if (ci === -1) continue;
        if (!includers[ci].includes(ti)) includers[ci].push(ti);
      }
    }
    const rootSet = new Set(['post', 'page', 'index', 'tag', 'tags'].map((r) => tplIndex.get(r)).filter((x) => x !== undefined));
    const dState = new Array(tplList.length).fill(0);
    const depthArr = new Array(tplList.length).fill(-1);
    const depthFromRoot = (ti) => {
      if (dState[ti] === 2) return depthArr[ti];
      if (dState[ti] === 1) return 99;
      dState[ti] = 1;
      let d;
      if (rootSet.has(ti)) d = 0;
      else {
        d = -1;
        for (const p of includers[ti]) {
          const pd = depthFromRoot(p);
          if (pd >= 99) { d = 99; break; }
          if (pd >= 0 && pd + 1 > d) d = pd + 1;
        }
      }
      dState[ti] = 2;
      depthArr[ti] = d;
      return d;
    };
    for (let ti = 0; ti < tplList.length; ti++) depthFromRoot(ti);
    const cState = new Array(tplList.length).fill(0);
    const isConstRec = (ti) => {
      if (cState[ti] === 2) return tplIsConst[ti];
      if (cState[ti] === 1) return false;
      cState[ti] = 1;
      let ok = !directFree[ti] && height[ti] < 99 && depthArr[ti] >= 0 && (depthArr[ti] + height[ti] < 8);
      if (ok) {
        for (const ci of incLists[ti]) {
          if (ci === -1) continue;
          if (!isConstRec(ci)) { ok = false; break; }
        }
      }
      cState[ti] = 2;
      tplIsConst[ti] = ok;
      return ok;
    };
    for (let ti = 0; ti < tplList.length; ti++) isConstRec(ti);
    if (process.env.MAKEFUN_X1_DEBUG) {
      for (let ti = 0; ti < tplList.length; ti++) {
        if (!tplIsConst[ti]) console.error(`[x1] nonconst ${tplList[ti]} directFree=${directFree[ti]} height=${height[ti]} depth=${depthArr[ti]} incs=[${incLists[ti].map((ci) => (ci === -1 ? '?' : tplList[ci])).join(',')}]`);
      }
    }
  }
  _curIsConst = tplIsConst;
  _curConstCache = new Array(tplList.length);
  _staticOff = 0;
  _x1TplNames = tplList;
  if (process.env.MAKEFUN_X1_DEBUG) {
    const names = tplList.filter((n, i) => tplIsConst[i]);
    console.error(`[x1] ${names.length}/${tplList.length} constant: ${names.join(',')}`);
  }

  // ---- 1. sources, sorted by path; md vs static; decline guards.
  const files = [...inp.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (typeof f.path !== 'string') { writeFallbackAnswer(inp); return; }
    if (isMdPath(f.path)) {
      if (f.uOff === -1) { writeFallbackAnswer(inp); return; }
      if (f.hasCR) f.uLen = tf_compactCR(f.uOff, f.uLen);
      sources.push({
        path: f.path, dir: dirOfStr(f.path), cOff: f.uOff, cEnd: f.uOff + f.uLen,
        titleOff: -1, titleLen: 0, dateOff: -1, dateLen: 0, dateInt: 0, hasDate: 0,
        layoutOff: -1, layoutLen: 0, hasLayout: 0, slugOff: -1, slugLen: 0, hasSlug: 0,
        summaryOff: -1, summaryLen: 0, hasSummary: 0, tags: null, draft: 0, hasDraft: 0,
        bodyOff: -1, bodyEnd: -1, post: 0, slug: null, slugStr: '', outDirStr: '',
        urlStr: '', url: null, htmlOff: 0, htmlLen: 0, excerptOff: 0, excerptLen: 0,
        toc: null, newer: null, older: null, tagRefs: null, card: null, page: null,
      });
    } else {
      statics.push({ path: f.path, rawQStart: f.rawQStart, rawQEnd: f.rawQEnd, content: f.content });
    }
  }

  // ---- 2. front matter.
  const kept = [];
  for (const s of sources) {
    const err = parseFmU8(s);
    if (err !== '') { report.push(`refused ${s.path}: ${err}`); continue; }
    s.post = s.path.startsWith('posts/') ? 1 : 0;
    let own = undefined;
    for (const d of RESERVED) { if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; } }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !s.hasDate) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.hasLayout ? asciiSlice(s.layoutOff, s.layoutOff + s.layoutLen) : (s.post ? 'post' : 'page');
    if (templates[layout] === undefined) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.draft === 1) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // ---- 3. permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : s.dir;
    let slug;
    if (s.hasSlug) slug = uniqueSlugRawU8(s.slugOff, s.slugLen, takenIn(dir));
    else {
      const base2 = slugifyU8(s.titleOff, s.titleOff + s.titleLen, s.titleArena ? _strBuf : _rawBuf);
      slug = uniqueSlugU8(base2.o, base2.l, takenIn(dir));
    }
    s.slug = slug;
    s.slugStr = _strBuf.toString('latin1', slug.o, slug.o + slug.l);
    s.outDirStr = dir === '' ? s.slugStr : dir + '/' + s.slugStr;
    s.urlStr = base + '/' + s.outDirStr + '/';
    s.url = strRangeOf(s.urlStr);
    bySource.set(s.path, s);
  }

  // ---- 4. markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCtx = { bySource, staticPaths, base, broken };
  for (const s of kept) {
    const env = { link: makeLinkFn(s, linkCtx) };
    renderMdU8(s, env);
  }

  // ---- 5. collections.
  const posts = kept.filter((s) => s.post === 1);
  posts.sort((x, y) => (y.dateInt - x.dateInt) || byCodeUnits(x.slugStr, y.slugStr));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // ---- 6. tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.tags || [];
    for (const t of tags) {
      const slug = slugifyU8(t.off, t.off + t.len);
      const key = _strBuf.toString('latin1', slug.o, slug.o + slug.l);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: t, slug, key });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug, key } of ownTags(p)) {
      if (!bySlug.has(key)) {
        const nameRange = copyToArena(u, name.off, name.off + name.len);
        const urlStr = base + '/tags/' + key + '/';
        bySlug.set(key, { name: nameRange, slug, slugStr: key, url: strRangeOf(urlStr), urlStr, posts: [] });
      }
      const tag = bySlug.get(key);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug, key }) => {
      const t = bySlug.get(key);
      if (t !== undefined) return t;
      const nameRange = copyToArena(u, name.off, name.off + name.len);
      return { name: nameRange, slug, slugStr: key, url: { o: 0, l: 0 }, urlStr: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slugStr, y.slugStr));

  // ---- cards / pages / links (memoized per source per case).
  const cardOf = (s) => {
    if (s.card !== null) return s.card;
    const dateRange = s.hasDate ? copyToArena(u, s.dateOff, s.dateOff + s.dateLen) : { o: 0, l: 0 };
    const dateLong = s.hasDate ? longDateU8(s.dateOff) : { o: 0, l: 0 };
    // Title/summary live in the string arena when quoted, in the raw buffer
    // when bare; normalize to the arena for slots.
    const titleA = s.titleArena ? { o: s.titleOff, l: s.titleLen } : copyToArena(u, s.titleOff, s.titleOff + s.titleLen);
    const summaryA = !s.hasSummary ? { o: 0, l: 0 } :
      (s.summaryArena ? { o: s.summaryOff, l: s.summaryLen } : copyToArena(u, s.summaryOff, s.summaryOff + s.summaryLen));
    const card = {
      title: titleA,
      url: s.url,
      date: dateRange,
      date_long: dateLong,
      summary: summaryA,
      excerpt: { o: s.excerptOff, l: s.excerptLen, h: 1 },
      reading_minutes: Math.max(1, Math.ceil(tf_wcU8(s.bodyOff, s.bodyEnd) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => {
    if (s === null) return null;
    const dateRange = s.hasDate ? copyToArena(u, s.dateOff, s.dateOff + s.dateLen) : { o: 0, l: 0 };
    const dateLong = s.hasDate ? longDateU8(s.dateOff) : { o: 0, l: 0 };
    const titleA = s.titleArena ? { o: s.titleOff, l: s.titleLen } : copyToArena(u, s.titleOff, s.titleOff + s.titleLen);
    return { title: titleA, url: s.url, date: dateRange, date_long: dateLong };
  };
  const pageOf = (s) => {
    if (s.page !== null) return s.page;
    const card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: { o: s.htmlOff, l: s.htmlLen, h: 1 },
      toc: s.toc.map((h) => ({ level: h.level, id: { o: h.idOff, l: h.idLen }, html: { o: h.htmlOff, l: h.htmlLen, h: 1 } })),
      newer: linkOf(s.newer),
      older: linkOf(s.older),
      is_post: s.post === 1,
    };
    s.page = page;
    return page;
  };

  // ---- 7. layouts: write the answer object, streaming.
  const slots = newSlots(pathList.length);
  const siteTitleRange = strRangeOf(siteTitle);
  const baseRange = strRangeOf(base);
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCards = posts.slice(0, recent).map((p) => cardOf(p));
  const pidSiteTitle = internPath('site.title');
  const pidSiteBase = internPath('site.base_url');
  const pidTags = internPath('tags');
  const pidRecent = internPath('recent');
  const pidPage = internPath('page');
  const pidPosts = internPath('posts');
  const pidPager = internPath('pager');
  const pidTag = internPath('tag');
  // The slot table was sized before these interns; grow it if needed.
  const needSlots = pathList.length;
  let sl = slots;
  if (sl.t.length < needSlots) sl = newSlots(needSlots);

  const outKeys = new Set();
  let firstEntry = true;
  const writeKey = (key) => {
    if (!firstEntry) outByte(44);
    firstEntry = false;
    outByte(34);
    outRawStr(key);
    outByte(34);
    outByte(58);
    outKeys.add(key);
  };
  const render = (name, vars) => {
    const c = templates[name];
    if (c === undefined) return false;
    sl.t.fill(0);
    setBytesSlot(sl, pidSiteTitle, siteTitleRange.o, siteTitleRange.l, false);
    setBytesSlot(sl, pidSiteBase, baseRange.o, baseRange.l, false);
    setArrSlot(sl, pidTags, allTags);
    setArrSlot(sl, pidRecent, recentCards);
    if (vars.page !== undefined) { setSlotFromValue(sl, pidPage, vars.page); fillObjectSlots(sl, vars.page, 'page'); }
    if (vars.posts !== undefined) setArrSlot(sl, pidPosts, vars.posts);
    if (vars.pager !== undefined) { setSlotFromValue(sl, pidPager, vars.pager); fillObjectSlots(sl, vars.pager, 'pager'); }
    if (vars.tag !== undefined) { setSlotFromValue(sl, pidTag, vars.tag); fillObjectSlots(sl, vars.tag, 'tag'); }
    execVm(c.ops, 0, c.ops.length >> 2, { slots: sl, templates: ctxTemplates, fors: c.fors }, 0);
    return true;
  };

  outByte(123); // '{'
  for (const s of kept) {
    const key = s.outDirStr + '/index.html';
    writeKey(key);
    outByte(34);
    render(s.layout, { page: pageOf(s) });
    outByte(34);
  }
  const per = perPage;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  if (templates['index'] !== undefined) {
    for (let k = 1; k <= pages; k++) {
      const key = k === 1 ? 'index.html' : 'page/' + k + '/index.html';
      writeKey(key);
      outByte(34);
      const pager = {
        number: k, total: pages,
        url: strRangeOf(indexUrl(k)),
        newer_url: k === 1 ? { o: 0, l: 0 } : strRangeOf(indexUrl(k - 1)),
        older_url: k === pages ? { o: 0, l: 0 } : strRangeOf(indexUrl(k + 1)),
      };
      render('index', { posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)), pager });
      outByte(34);
    }
  }
  if (templates['tag'] !== undefined) {
    for (const t of tags) {
      const key = 'tags/' + t.slugStr + '/index.html';
      writeKey(key);
      outByte(34);
      const tagView = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) };
      render('tag', { tag: tagView });
      outByte(34);
    }
  }
  if (templates['tags'] !== undefined) {
    writeKey('tags/index.html');
    outByte(34);
    render('tags', {});
    outByte(34);
  }
  for (const f of statics) {
    if (outKeys.has(f.path)) { report.push(`shadowed ${f.path}: a built page has its path`); continue; }
    writeKey(f.path);
    if (f.rawQStart !== -1) {
      outBytes(_rawBuf, f.rawQStart, f.rawQEnd);
    } else {
      outByte(34);
      outRawStr(f.content);
      outByte(34);
    }
  }
  // ---- 8. report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pages2 = kept.filter((s) => !s.post).length;
  lines.push(`built ${pages2} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  writeKey('build-report.txt');
  outByte(34);
  outRawStr(lines.join('\n') + '\n');
  outByte(34);
  outByte(125); // '}'
}

// Warm up the tf_* kernels on a tiny synthetic case so the first real case
// runs compiled. The warmup output is discarded (arena reset after).
function warmup() {
  const tiny = Buffer.from(JSON.stringify([{ id: 'w', input: {
    site: { title: 'Warm', base_url: 'https://example.test/', per_page: 2, recent: 2 },
    templates: {
      page: '<h1>{{ page.title }}</h1>\n{{{ page.content }}}\n{% for t in page.tags %}<a href="{{ t.url }}">{{ t.name }}</a>{% endfor %}',
      post: '<article>{{ page.title }} {{ page.date_long }}</article>\n{{{ page.content }}}',
      index: '{% for p in posts %}<a href="{{ p.url }}">{{ p.title }}</a> ({{ p.reading_minutes }}){% endfor %}{{ pager.number }}/{{ pager.total }}',
      tag: '<h1>{{ tag.name }} ({{ tag.count }})</h1>{% for p in tag.posts %}{{ p.title }}{% endfor %}',
      tags: '{% for t in tags %}{{ t.name }}:{{ t.count }};{% endfor %}',
    },
    files: [
      { path: 'hello.md', content: '---\ntitle: Hello World\ndate: 2026-11-09\ntags: [news, dev]\n---\n\n# Hello **bold** and `code`\n\nA paragraph with [a link](other.md) and *em*.\n\n- one\n- two\n' },
      { path: 'other.md', content: '---\ntitle: Other Page\n---\n\nJust text.\n' },
      { path: 'posts/first.md', content: '---\ntitle: First Post\ndate: 2026-11-10\ntags: [news]\n---\n\nPost body here.\n' },
      { path: 'style.css', content: 'body { color: red; }\n' },
    ],
  } }]), 'utf8');
  const savedU8 = _rawU8, savedBuf = _rawBuf, savedOut = _outOff;
  _rawBuf = tiny;
  _rawU8 = new Uint8Array(tiny.buffer, tiny.byteOffset, tiny.byteLength);
  let p = skipWs(_rawU8, 0);
  p = skipWs(_rawU8, p + 1);
  for (let r = 0; r < 3; r++) {
    const rec = readCaseObj(_rawU8, _rawBuf, p);
    runStreamCase(rec);
    _outOff = 0;
  }
  _rawU8 = savedU8; _rawBuf = savedBuf; _outOff = savedOut;
}

function runCli() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const rawBuf = readFileSync(`${inputDir}/cases.json`);
  const rawU8 = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
  _rawBuf = rawBuf;
  _rawU8 = rawU8;
  _outBuf = Buffer.allocUnsafe(OUT_CAP);
  _outU8 = new Uint8Array(_outBuf.buffer, _outBuf.byteOffset, _outBuf.byteLength);
  _outOff = 0;
  _outFd = openSync(`${outputDir}/answers.json`, 'w');
  try {
    warmup();
    _outOff = 0;
    outByte(91); // '['
    let p = (rawU8.length >= 3 && rawU8[0] === 0xEF && rawU8[1] === 0xBB && rawU8[2] === 0xBF) ? 3 : 0;
    p = skipWs(rawU8, p);
    if (rawU8[p] === 91) {
      p = skipWs(rawU8, p + 1);
      let firstCase = true;
      while (p < rawU8.length && rawU8[p] !== 93) {
        const caseRec = readCaseObj(rawU8, rawBuf, p);
        p = skipWs(rawU8, _jp);
        if (!firstCase) outByte(44);
        firstCase = false;
        runStreamCase(caseRec);
        if (rawU8[p] === 44) p = skipWs(rawU8, p + 1);
      }
    }
    outByte(93); // ']'
    outByte(10);
    outFlush();
    if (X1_DEBUG) console.error(`[x1] totals: captures=${_x1Caps} capBytes=${_x1CapBytes} replays=${_x1Reps} repBytes=${_x1RepBytes} staticOff=${_staticOff}`);
  } catch (err) {
    // Safety net: the raw buffer was unescaped in place by the streaming
    // parser, so it is no longer valid JSON — re-read the file from disk
    // and run the exact fallback for every case.
    console.error('exp11 primary failed, falling back:', err && err.stack ? err.stack : err);
    try { closeSync(_outFd); } catch (e) {}
    _outFd = openSync(`${outputDir}/answers.json`, 'w');
    _outOff = 0;
    const fresh = readFileSync(`${inputDir}/cases.json`);
    const cases = JSON.parse(fresh.toString('utf8'));
    const answers = cases.map((c) => getFallbackRun()(c.input));
    outUtf8(JSON.stringify(answers));
    outFlush();
  }
  closeSync(_outFd);
}

// The house-driver entry point: one case's input object -> the exact
// fallback answer (used when the harness runs the house main.ts).
function run(input) { return getFallbackRun()(input); }

module.exports = { run, runCli };
