// Finds vocabulary and sentence rows whose text is in the wrong language and replaces
// that text with a translation of the linked English line. Line numbers and links stay put.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const apply = process.argv.includes('--apply');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const letters = ['C', 'E', 'F', 'G', 'I', 'J', 'K', 'P', 'R', 'S'];
const names = {
  C: 'Chinese', E: 'English', F: 'French', G: 'German', I: 'Italian',
  J: 'Japanese', K: 'Korean', P: 'Portuguese', R: 'Russian', S: 'Spanish'
};
const targets = { C: 'zh-CN', E: 'en', F: 'fr', G: 'de', I: 'it', J: 'ja', K: 'ko', P: 'pt', R: 'ru', S: 'es' };
const rx = /^(.*) \(([^()]*)\) \(([A-Z]*)\)$/;
const BATCH = process.argv.includes('--pure') ? 1 : 80;
const MAX_QUERY = 13800;

const log = (msg) => console.log(new Date().toISOString().slice(11, 19) + ' ' + msg);

function readText(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) throw new Error('BOM ' + file);
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}
function atomicWrite(file, text) {
  const tmp = file + '.tmpwrite';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, text);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}
function stripCf(s) { return String(s || '').replace(/\p{Cf}/gu, ''); }
function numericLike(s) {
  const t = stripCf(s).trim();
  if (!/\d/.test(t)) return false;
  const core = t.replace(/[ap]\.?m\.?/gi, '').replace(/\s+/g, '');
  return /^[\d:./,+\-]+$/.test(core);
}
function norm(s) {
  return stripCf(s).replace(/[\u2018\u2019]/g, "'").replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function sameEnglish(text, en) {
  if (!en) return false;
  const a = norm(text);
  const b = norm(en);
  return a.length >= 2 && a === b;
}
const cueWords = new Set(['the', 'you', 'your', 'are', 'is', 'what', 'where', 'why', 'how', 'this', 'that', 'have', 'thank', 'goodbye', 'hello', 'please', 'they', 'them', 'their', 'with', 'from', 'she', 'we', 'it', 'and', 'to', "don't", "it's", "there's", "i'm", "you're", "we're", "they're", "isn't", "aren't", "can't", "won't", "didn't", "doesn't"]);
function hasEnglishCue(text) {
  const words = stripCf(text).toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  for (const w of words) {
    if (cueWords.has(w)) return true;
    if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3\u0400-\u04ff]/.test(w)) {
      const bits = w.match(/[a-z']+/g) || [];
      if (bits.some((b) => cueWords.has(b))) return true;
    }
  }
  return false;
}
function nativeOf(letter, text) {
  if (letter === 'J') return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
  if (letter === 'C') return /[\u4e00-\u9fff]/.test(text);
  if (letter === 'K') return /[\uac00-\ud7a3]/.test(text);
  if (letter === 'R') return /[\u0400-\u04ff]/.test(text);
  return /[A-Za-z\u00C0-\u024F]/.test(text);
}
function bad(letter, text, english) {
  const t = stripCf(text).trim();
  if (!t || numericLike(t)) return false;
  const list = Array.isArray(english) ? english : (english ? [english] : []);
  const echoed = list.some((en) => sameEnglish(t, en));
  const words = norm(t).split(' ').filter(Boolean);
  const cjk = letter === 'J' || letter === 'C' || letter === 'K' || letter === 'R';
  if (letter === 'E') {
    const foreign = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3\u0400-\u04ff]/.test(t);
    return foreign && !/[A-Za-z]/.test(t);
  }
  if (cjk) {
    if (/[A-Za-z]/.test(t) && !nativeOf(letter, t)) return true;
    if (hasEnglishCue(t)) return true;
    return echoed && (words.length >= 2 || !nativeOf(letter, t));
  }
  if (hasEnglishCue(t)) return true;
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3\u0400-\u04ff]/.test(t) && !nativeOf(letter, t)) return true;
  return echoed && words.length >= 3;
}
function detectSl(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  return 'en';
}
function englishLines(ids, bank) {
  const out = [];
  const re = /(?:^|, )E(\d+)/g;
  let m;
  while ((m = re.exec(ids))) {
    const row = bank[Number(m[1]) - 1];
    if (row) out.push(row.text);
  }
  return out;
}
function parse(line, file, n) {
  const m = rx.exec(line);
  if (!m) throw new Error('Unparsed ' + file + ' line ' + n);
  return { text: m[1], ids: m[2], missing: m[3] };
}
function firstEnglish(ids) {
  const m = /(?:^|, )E(\d+)/.exec(ids);
  return m ? Number(m[1]) : 0;
}
function clean(raw, sentences) {
  let s = stripCf(raw).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  s = s.replace(/^["'«»„“]+|["'«»“”]+$/g, '').replace(/["'«»“”]+$/g, '').trim();
  s = s.replace(/《+\d+》+/g, ' ').replace(/<<<\d+>>>/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[>＞]+|[>＞]+$/g, '').trim();
  if (!sentences) s = s.replace(/[\s.\u3002!\uFF01?\uFF1F\u2026]+$/g, '').trim();
  if (/<<<\d+>>>/.test(s) || /\[\[\d+\]\]/.test(s)) return '';
  if (/[~～<>＜＞《》〈〉]/.test(s)) return '';
  return s;
}

function load(kind) {
  const dir = path.join(root, kind);
  const banks = {};
  for (const L of letters) {
    const file = path.join(dir, names[L] + '.txt');
    const lines = readText(file).split(/\r?\n/);
    banks[L] = { file, lines, parsed: lines.map((line, i) => parse(line, file, i + 1)) };
  }
  return banks;
}

function collect(banks, sentences) {
  const jobs = [];
  for (const L of letters) {
    if (only && only !== L && only !== names[L]) continue;
    const bank = banks[L];
    bank.parsed.forEach((row, i) => {
      const ens = L === 'E' ? [] : englishLines(row.ids, banks.E.parsed);
      if (!bad(L, row.text, ens)) return;
      const match = ens.find((t) => sameEnglish(row.text, t));
      if (process.argv.includes('--pure')) {
        const cjk = L === 'J' || L === 'C' || L === 'K' || L === 'R';
        if (L !== 'E' && cjk && nativeOf(L, row.text)) return;
        if (L !== 'E' && !cjk && !sameEnglish(row.text, match || ens[0] || '')) return;
      }
      const source = stripCf(match || ens[0] || row.text).trim();
      if (!source) return;
      jobs.push({ L, i, source, sl: L === 'E' ? detectSl(row.text) : 'en' });
    });
  }
  return jobs;
}

let nextSlot = 0;
let gtxCoolUntil = 0;
async function takeSlot() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + 60;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}
function marker(i) { return '<<<' + i + '>>>'; }
function decodeBody(data) {
  if (typeof data === 'string') return data;
  if (!Array.isArray(data) || !data.length) return '';
  if (typeof data[0] === 'string') return data.join('');
  if (Array.isArray(data[0])) return data[0].map((x) => (x && x[0]) || '').join('');
  return '';
}
async function fetchTranslation(q, tl, sl) {
  const gtx = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(q)}`;
  const alt = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${encodeURIComponent(q)}`;
  const urls = Date.now() < gtxCoolUntil ? [alt] : [gtx, alt];
  let last = 0;
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 429 || res.status === 403) {
      last = res.status;
      if (url.includes('client=gtx')) gtxCoolUntil = Date.now() + 10 * 60 * 1000;
      continue;
    }
    if (res.status >= 500) { last = res.status; continue; }
    if (!res.ok) throw new Error('translate ' + tl + ' ' + res.status);
    return decodeBody(await res.json());
  }
  throw new Error('translate ' + tl + ' ' + (last || 429));
}
function parseMarked(text, count) {
  const re = /<<<(\d+)>>>/g;
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push({ i: Number(m[1]), at: m.index, len: m[0].length });
  if (!hits.length) return null;
  const out = new Array(count).fill('');
  for (let h = 0; h < hits.length; h++) {
    const start = hits[h].at + hits[h].len;
    const end = h + 1 < hits.length ? hits[h + 1].at : text.length;
    const idx = hits[h].i;
    if (idx >= 0 && idx < count && !out[idx]) out[idx] = text.slice(start, end);
  }
  return out;
}
function chunk(items) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const item of items) {
    const addition = encodeURIComponent(marker(cur.length) + ' ' + item).length + (cur.length ? 3 : 0);
    if (cur.length && (cur.length >= BATCH || len + addition > MAX_QUERY)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(item);
    len += encodeURIComponent(marker(cur.length - 1) + ' ' + item).length + (cur.length > 1 ? 3 : 0);
  }
  if (cur.length) out.push(cur);
  return out;
}
async function translateOnce(lines, tl, sl, attempt = 0) {
  if (lines.length === 1) {
    await takeSlot();
    try { return [await fetchTranslation(lines[0], tl, sl)]; }
    catch (e) {
      if (attempt >= 4) return [''];
      await new Promise((r) => setTimeout(r, Math.min(15000, 400 * 2 ** attempt)));
      return translateOnce(lines, tl, sl, attempt + 1);
    }
  }
  await takeSlot();
  const payload = lines.map((s, i) => marker(i) + ' ' + s).join('\n');
  let text = '';
  try { text = await fetchTranslation(payload, tl, sl); }
  catch (e) {
    if (attempt >= 3) return null;
    await new Promise((r) => setTimeout(r, Math.min(15000, 400 * 2 ** attempt)));
    return translateOnce(lines, tl, sl, attempt + 1);
  }
  const parsed = parseMarked(text, lines.length);
  if (!parsed) {
    if (attempt >= 2) return null;
    return translateOnce(lines, tl, sl, attempt + 1);
  }
  return parsed;
}
async function translateMany(lines, tl, sl) {
  if (!lines.length) return [];
  const got = await translateOnce(lines, tl, sl);
  if (got) return got;
  if (lines.length === 1) return [''];
  const mid = Math.ceil(lines.length / 2);
  return (await translateMany(lines.slice(0, mid), tl, sl)).concat(await translateMany(lines.slice(mid), tl, sl));
}

async function repair(kind) {
  log('loading ' + kind);
  const sentences = kind === 'Sentences';
  const banks = load(kind);
  const jobs = collect(banks, sentences);
  const byLang = {};
  for (const job of jobs) {
    if (!byLang[job.L]) byLang[job.L] = [];
    byLang[job.L].push(job);
  }
  for (const L of letters) {
    const list = byLang[L] || [];
    const interesting = list.filter((job) => hasEnglishCue(banks[L].parsed[job.i].text));
    const sample = (interesting.length ? interesting : list).slice(0, 5).map((job) => banks[L].parsed[job.i].text + '  <=  ' + job.source);
    log(names[L] + ' ' + kind + ': ' + list.length + ' wrong-language rows');
    for (const line of sample) log('  ' + line.slice(0, 160));
  }
  if (!apply) return;

  for (const L of letters) {
    const list = byLang[L] || [];
    if (!list.length) continue;
    const groups = new Map();
    for (const job of list) {
      if (!groups.has(job.sl)) groups.set(job.sl, new Map());
      groups.get(job.sl).set(job.source, true);
    }
    const translated = new Map();
    for (const [sl, sources] of groups) {
      const unique = [...sources.keys()];
      log(names[L] + ': translating ' + unique.length + ' distinct lines from ' + sl + ' into ' + targets[L]);
      const parts = chunk(unique);
      let done = 0;
      const queue = parts.map((part, n) => async () => {
        const got = await translateMany(part, targets[L], sl);
        part.forEach((src, i) => {
          const text = clean(got[i] || '', sentences);
          if (text && !bad(L, text, src)) translated.set(sl + '\n' + src, text);
        });
        done += part.length;
        if (n % 5 === 0 || done === unique.length) log(names[L] + ': ' + done + '/' + unique.length + ', kept ' + translated.size);
      });
      const active = new Set();
      for (const run of queue) {
        const p = run().finally(() => active.delete(p));
        active.add(p);
        if (active.size >= 4) await Promise.race(active);
      }
      await Promise.all(active);
    }

    let changed = 0;
    let failed = 0;
    for (const job of list) {
      const text = translated.get(job.sl + '\n' + job.source);
      const row = banks[L].parsed[job.i];
      if (!text || text === row.text) { failed++; continue; }
      banks[L].lines[job.i] = text + ' (' + row.ids + ') (' + row.missing + ')';
      changed++;
    }
    if (changed) atomicWrite(banks[L].file, banks[L].lines.join('\r\n'));
    log(names[L] + ': replaced ' + changed + ', still wrong ' + failed);
  }
}

const kinds = process.argv.includes('--sentences') ? ['Sentences']
  : process.argv.includes('--vocab') ? ['Vocabulary']
  : ['Vocabulary', 'Sentences'];
for (const kind of kinds) await repair(kind);
log(apply ? 'done' : 'scan only');
