#!/usr/bin/env node
/*
 * hinge-read.js — scrape / draft / send helpers. Prefer `node hinge.js`.
 *
 * Usage:
 *   node hinge-read.js                 # scrape → draft → send
 *   DRY_RUN=1 node hinge-read.js       # type the line, don't send
 *   NODRAFT=1 node hinge-read.js       # scrape only
 *   SERIAL=192.168.1.42:5555 node hinge-read.js
 *   VERBOSE=1 node hinge-read.js       # also print every raw node
 *
 * Always locks the phone when the process ends (success, error, or Ctrl+C).
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findAdb() {
  const home = process.env.HOME || '';
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).map(d => path.join(d, 'adb')),
    '/opt/homebrew/bin/adb',
    path.join(home, '.nexustools/adb'),
    path.join(home, 'Library/Android/sdk/platform-tools/adb'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return 'adb';
}
const ADB     = process.env.ADB || findAdb();
let   TARGET  = process.env.SERIAL || '';
const VERBOSE = process.env.VERBOSE === '1';
const NODRAFT = process.env.NODRAFT === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const MODEL   = process.env.MODEL || 'gpt-5.6';
const MAX_LINE = 255;
const LOAD_TIMEOUT = parseInt(process.env.LOAD_TIMEOUT || '12000', 10);
const PKG = 'co.hinge.app';
const SHOTS_DIR = process.env.SHOTS_DIR || 'screenshots';
const CROPS_DIR = process.env.CROPS_DIR || 'screenshots_cropped';
// Send-sheet photo card on a 1080x2400 capture (crop_collage.py).
const SEND_CROP = [108, 242, 972, 1104];
const SEND_SIZE = [1080, 2400];

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
const log   = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function adb(args, wantOut = false, timeoutMs = 0) {
  const full = TARGET ? ['-s', TARGET, ...args] : args;
  try {
    return execFileSync(ADB, full, {
      encoding: 'utf8',
      stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'pipe'],
      timeout: timeoutMs || undefined,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    const err = String(e.stderr || '').trim().split('\n').filter(Boolean).slice(0, 2).join(' — ');
    if (err) e.message = `${e.message}\n${err}`;
    throw e;
  }
}
const wake = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {} };
const sleepScreen = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']); } catch (_) {} };
const tap = (x, y) => adb(['shell', 'input', 'tap', `${Math.round(x)}`, `${Math.round(y)}`]);
const swipe = (x1, y1, x2, y2, d = 450) =>
  adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, d].map(v => `${Math.round(v)}`)]);

function launchHinge() {
  wake();
  try { adb(['shell', 'wm', 'dismiss-keyguard']); } catch (_) {}
  adb(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
}

let SCREEN;
function screenSize() {
  if (SCREEN) return SCREEN;
  try {
    const m = /(\d+)x(\d+)/.exec(adb(['shell', 'wm', 'size'], true) || '');
    if (m) SCREEN = { w: +m[1], h: +m[2] };
  } catch (_) {}
  SCREEN = SCREEN || { w: 1080, h: 2400 };
  return SCREEN;
}
function swipeProfile(dir) {
  const { w, h } = screenSize();
  const x = w / 2, a = h * 0.70, b = h * 0.38;
  if (dir === 'down') swipe(x, a, x, b, 420);
  else                swipe(x, b, x, a, 420);
}

const stamp = () => new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
function shotSlug(name) {
  return String(name || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'profile';
}
function screenshot(name) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const args = TARGET ? ['-s', TARGET, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
    const png = execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024 });
    const file = path.join(SHOTS_DIR, name);
    fs.writeFileSync(file, png);
    return file;
  } catch (e) { log('  ! screenshot failed:', e.message.split('\n')[0]); return null; }
}
function cropPng(src, dest, box) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const [l, t, r, b] = box.map(Math.round);
    const py = [
      'from PIL import Image',
      `im = Image.open(${JSON.stringify(src)})`,
      `l=max(0,${l}); t=max(0,${t}); r=min(im.width,${r}); b=min(im.height,${b})`,
      `im.convert("RGB").crop((l,t,r,b)).save(${JSON.stringify(dest)})`,
    ].join('\n');
    execFileSync('python3', ['-c', py], { timeout: 8000, stdio: ['ignore', 'ignore', 'pipe'] });
    return dest;
  } catch (e) {
    const err = String(e.stderr || e.message || '').trim().split('\n')[0];
    log('  ! crop skipped', err ? `— ${err}` : '');
    return null;
  }
}
function scaleSendCrop() {
  const { w, h } = screenSize();
  return SEND_CROP.map((v, i) => Math.round(v * (i % 2 === 0 ? w / SEND_SIZE[0] : h / SEND_SIZE[1])));
}
function firstPhotoNode(xml) {
  const { h } = screenSize();
  const photos = allNodes(xml).filter(n =>
    n.cls === 'ImageView' && /(?:photo|video)$/i.test(n.desc) && (n.bot - n.top) > 220
  ).sort((a, b) => a.top - b.top);
  return photos.find(n => n.top < h * 0.72) || photos[0] || null;
}
function captureFirstPhoto(xml, who) {
  const n = firstPhotoNode(xml);
  const base = `${stamp()}_${shotSlug(who)}`;
  const full = screenshot(`${base}_first.png`);
  if (!full) return null;
  const box = n
    ? [n.left, n.top, n.right, n.bot]
    : scaleSendCrop();
  const cropped = cropPng(full, path.join(CROPS_DIR, `${base}_first.png`), box);
  if (cropped) {
    try { fs.unlinkSync(full); } catch (_) {}
    log(`First photo → ${cropped}`);
    return cropped;
  }
  log(`First photo (uncropped) → ${full}`);
  return full;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/u;
const HOMOGLYPHS = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
  '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i',
  '\u0410': 'A', '\u0415': 'E', '\u041E': 'O', '\u0420': 'P',
  '\u0421': 'C', '\u0423': 'Y', '\u0425': 'X', '\u0406': 'I',
  '\u03BF': 'o', '\u039F': 'O', '\u03B1': 'a',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00A0': ' ',
};
function foldToInputAscii(text) {
  let s = String(text).normalize('NFKC').replace(/[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0410\u0415\u041E\u0420\u0421\u0423\u0425\u0406\u03BF\u039F\u03B1\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0]/g, ch => HOMOGLYPHS[ch] || ch);
  const lost = [];
  s = [...s].filter(ch => {
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) return true;
    lost.push(ch);
    return false;
  }).join('').replace(/\s+/g, ' ').trim();
  return { text: s, lost };
}
let _hasAdbKb;
function hasAdbKeyboard() {
  if (_hasAdbKb !== undefined) return _hasAdbKb;
  try { _hasAdbKb = /com\.android\.adbkeyboard/.test(adb(['shell', 'pm', 'list', 'packages', 'com.android.adbkeyboard'], true)); }
  catch (_) { _hasAdbKb = false; }
  return _hasAdbKb;
}
function typeViaAdbKeyboard(text) {
  let prev = '';
  try { prev = adb(['shell', 'settings', 'get', 'secure', 'default_input_method'], true).trim(); } catch (_) {}
  adb(['shell', 'ime', 'enable', 'com.android.adbkeyboard/.AdbIME']);
  adb(['shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
  adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text, 'utf8').toString('base64')]);
  if (prev && !/adbkeyboard/.test(prev)) adb(['shell', 'ime', 'set', prev]);
}
function typeViaInputText(text) {
  const CHUNK = 90;
  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK).replace(/%/g, '%%').replace(/ /g, '%s').replace(/'/g, "\\'");
    adb(['shell', 'input', 'text', piece]);
  }
}
function typeText(text) {
  const raw = String(text);
  if (hasAdbKeyboard() && (/[^\x20-\x7E]/.test(raw) || EMOJI.test(raw))) {
    typeViaAdbKeyboard(raw);
    return;
  }
  const { text: clean, lost } = foldToInputAscii(raw);
  if (lost.length) {
    const uniq = [...new Set(lost)].map(c => `U+${c.codePointAt(0).toString(16).toUpperCase()}`);
    log(`  ! dropped untypeable chars (${uniq.join(' ')}) — install ADBKeyboard for Unicode`);
  }
  if (!clean) throw new Error('opener is empty after ASCII sanitise');
  typeViaInputText(clean);
}

function unescapeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
function attr(attrs, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]) : '';
}

async function getUI() {
  for (let i = 0; i < 4; i++) {
    try {
      adb(['shell', 'uiautomator', 'dump', '/sdcard/hinge_ui.xml'], false, 8000);
      const xml = adb(['shell', 'cat', '/sdcard/hinge_ui.xml'], true, 5000);
      if (xml && xml.includes('<hierarchy')) return xml;
    } catch (_) {}
    await delay(700);
  }
  return '';
}
function allNodes(xml) {
  const re = /<node\b([^>]*?)\/?>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const desc = attr(m[1], 'content-desc');
    const text = attr(m[1], 'text');
    if (!desc && !text) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[1]);
    if (!b) continue;
    const [, x1, y1, x2, y2] = b.map(Number);
    out.push({
      desc, text,
      cls: (attr(m[1], 'class') || '').split('.').pop(),
      cx: (x1 + x2) / 2, cy: (y1 + y2) / 2,
      top: y1, bot: y2, left: x1, right: x2,
    });
  }
  return out;
}
const findDesc = (xml, re) => allNodes(xml).filter(n => re.test(n.desc));

function profileName(xml) {
  const skip = findDesc(xml, /^Skip /)[0];
  if (skip) {
    const n = skip.desc.replace(/^Skip\s+/i, '').trim();
    if (n) return n;
  }
  for (const node of findDesc(xml, /(?:photo|video)$/i)) {
    const n = node.desc
      .replace(/[’'`]s\s+(photo|video)$/i, '')
      .replace(/\s+(photo|video)$/i, '')
      .trim();
    if (n && !/^(like|unlike|skip|play|pause)$/i.test(n)) return n;
  }
  return '';
}

async function waitFor(re, timeout = LOAD_TIMEOUT) {
  const deadline = Date.now() + timeout;
  do {
    const xml = await getUI();
    const hits = findDesc(xml, re);
    if (hits.length) return { nodes: hits, xml };
    await delay(600);
  } while (Date.now() < deadline);
  return null;
}

// App chrome — never profile content.
// Like hearts are labeled "Like photo", "Like prompt", "Like photo prompt",
// "Like video prompt", "Like voice prompt", etc. All of those are controls.
const CHROME = new RegExp(
  '^(Discover|Standouts|Likes You|Profile Hub|More|Undo last skip' +
  '|Dating preferences|Age filter options|Height filter options' +
  '|Dating intentions filter options' +
  '|Selfie verified|Get verified' +
  '|Mute|Unmute|Open video|Rewind)$',
  'i'
);
function isControlLabel(s) {
  s = String(s || '').trim();
  if (!s) return false;
  if (/^(Like|Unlike|Skip|Send)\b/i.test(s)) return true;
  if (/^(Play|Pause|Mute|Unmute)\b/i.test(s)) return true;
  if (/^Signals filter\b/i.test(s)) return true;
  if (CHROME.test(s) || /^Matches/.test(s)) return true;
  if (/[’'`]s\s+(photo|video)$/i.test(s)) return true;
  return false;
}
const PRONOUN_BIT = /^(she|her|he|him|they|them)$/i;
function isJunkText(s) {
  s = String(s || '').trim();
  return isControlLabel(s) || PRONOUN_BIT.test(s);
}
const VITAL = /^(Age|Gender|Sexuality|Religion|Ethnicity|Height|Location|Job|Education|Hometown|Politics|Drinking|Smoking|Cannabis|Kids|Family Plans|Pets|Zodiac|Languages|School|Work|Dating Intentions|Relationship type|Looking for|Family plans|Children|Covid vaccine|Pets)$/i;

function isChrome(n) {
  return isControlLabel(n.desc) || isControlLabel(n.text);
}
function parsePrompt(desc) {
  const m = /^Prompt:\s*([\s\S]+)$/i.exec(desc || '');
  if (!m) return null;
  const rest = m[1];
  const cut = rest.search(/\.\s*Answer:\s*/);
  if (cut >= 0) {
    return { q: rest.slice(0, cut).trim(), a: rest.slice(cut).replace(/^\.\s*Answer:\s*/, '').trim() };
  }
  const cut2 = rest.search(/\s+Answer:\s*/);
  if (cut2 >= 0) {
    return { q: rest.slice(0, cut2).trim(), a: rest.slice(cut2).replace(/^\s*Answer:\s*/, '').trim() };
  }
  return { q: rest.trim(), a: '' };
}

function atProfileTop(xml) {
  return findDesc(xml, /^(Dating preferences|Age filter options)$/).length > 0;
}
async function scrollToTop() {
  for (let i = 0; i < 14; i++) {
    const xml = await getUI();
    if (xml && atProfileTop(xml)) return xml;
    swipeProfile('up');
    await delay(400);
  }
  return getUI();
}

function harvest(xml) {
  const { h } = screenSize();
  const ns = allNodes(xml).filter(n => n.bot > 160 && n.top < h * 0.91);
  const items = [];
  const seenVal = new Set();

  for (const n of ns) {
    if (isChrome(n)) continue;
    const blob = `${n.desc} ${n.text}`;
    const p = parsePrompt(n.desc);
    if (p && (p.q || p.a)) {
      const voice = /voice/i.test(blob);
      const video = /video/i.test(blob);
      const choice = /poll|this or that|would you rather|two options|choose one/i.test(blob);
      items.push({
        kind: voice ? 'voice' : video ? 'video' : choice ? 'choice' : 'prompt',
        q: p.q, a: p.a, raw: n.desc,
      });
      continue;
    }
    if (/voice prompt/i.test(n.desc) || (/^voice$/i.test(n.desc) && n.text)) {
      items.push({ kind: 'voice', q: (n.text || n.desc).trim(), a: '', raw: n.desc || n.text });
      continue;
    }
    if (/video/i.test(n.desc) && !isChrome(n) && n.text) {
      items.push({ kind: 'video', q: n.text.trim(), a: '', raw: n.desc });
      continue;
    }
  }

  for (const n of ns) {
    if (!VITAL.test(n.desc) || n.text) continue;
    const val = ns
      .filter(o => o.text && o.left >= n.left - 10 && Math.abs(o.cy - n.cy) < 90)
      .sort((a, b) => a.left - b.left)[0];
    if (val) {
      items.push({ kind: 'vital', q: n.desc, a: val.text.trim(), raw: `${n.desc}: ${val.text.trim()}` });
      seenVal.add(val.text.trim());
    }
  }

  // Poll / choice chips: short Button texts sitting under a question, no Prompt: desc.
  const buttons = ns.filter(n => n.cls === 'Button' && n.text && !isChrome(n) && n.text.length < 80);
  if (buttons.length >= 2 && buttons.length <= 4) {
    const opts = buttons.map(b => b.text.trim());
    items.push({ kind: 'choice', q: '', a: opts.join(' | '), raw: opts.join(' | '), opts });
    opts.forEach(o => seenVal.add(o));
  }

  for (const n of ns) {
    if (isChrome(n)) continue;
    const t = (n.text || '').trim();
    const d = (n.desc || '').trim();
    if (t && !seenVal.has(t) && !/^Prompt:/i.test(d) && !isJunkText(t)) {
      items.push({ kind: 'text', q: t, a: '', raw: t, src: 'text' });
      seenVal.add(t);
    }
    if (d && !/^Prompt:/i.test(d) && !VITAL.test(d) && !seenVal.has(d) && !isJunkText(d)) {
      items.push({ kind: 'text', q: d, a: '', raw: d, src: 'desc' });
      seenVal.add(d);
    }
  }

  if (VERBOSE) {
    for (const n of ns) {
      const bits = [];
      if (n.desc) bits.push(`desc=${JSON.stringify(n.desc)}`);
      if (n.text) bits.push(`text=${JSON.stringify(n.text)}`);
      items.push({ kind: 'raw', q: `${n.cls} y=${n.top}`, a: bits.join('  '), raw: bits.join('  ') });
    }
  }

  return { items, who: profileName(xml) };
}

function formatProfile(p) {
  const who = p.who || 'someone';
  const extra = [];
  if (p.pronouns) extra.push(p.pronouns);
  const lines = [`profile  ${[who, ...extra].join('  ·  ')}`, ''];
  const counts = { prompt: 0, voice: 0, video: 0, choice: 0 };
  const used = new Set();
  const emit = (label, q, a) => {
    const key = `${label}|${q}|${a}`;
    if (used.has(key)) return;
    used.add(key);
    if (a) {
      lines.push(`${label}: ${JSON.stringify(q)}`);
      lines.push(`${' '.repeat(label.length)}  ${JSON.stringify(a)}`);
    } else {
      lines.push(`${label}: ${JSON.stringify(q)}`);
    }
  };

  for (const it of p.items) {
    if (it.kind === 'raw' || it.kind === 'vital') continue;
    if (it.kind === 'text' && (it.q === who || it.q === p.pronouns || isJunkText(it.q))) continue;
    if (it.kind === 'prompt' || it.kind === 'voice' || it.kind === 'video' || it.kind === 'choice') {
      counts[it.kind]++;
      const label = `${it.kind}${counts[it.kind]}`;
      if (it.opts) emit(label, it.q || it.a, '');
      else emit(label, it.q, it.a);
    }
  }

  const vitals = p.items.filter(it => it.kind === 'vital');
  if (vitals.length) {
    lines.push('');
    for (const v of vitals) lines.push(`${v.q}: ${v.a}`);
  }

  const rest = p.items.filter(it => {
    if (it.kind !== 'text') return false;
    if (it.q === who || it.q === p.pronouns || isJunkText(it.q)) return false;
    if (used.has(`text|${it.q}|`)) return false;
    return true;
  });
  if (rest.length) {
    lines.push('');
    let i = 0;
    for (const it of rest) emit(`text${++i}`, it.q, '');
  }
  return lines.join('\n').trim() + '\n';
}
function printProfile(p) {
  process.stdout.write(formatProfile(p) + '\n');
}

function parseDraft(raw) {
  const s = String(raw || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return JSON');
  const obj = JSON.parse(body.slice(start, end + 1));
  const line = String(obj.line || '').trim();
  if (!line) throw new Error('model returned an empty line');
  return {
    line,
    hook: String(obj.hook || '').trim(),
    chars: [...line].length,
  };
}

async function draftOpener(profileText) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing — add it to .env');
  const system = fs.readFileSync(path.join(__dirname, 'opener-prompt.md'), 'utf8');
  const user = `Draft a like-comment for this Hinge profile.\n\n${profileText}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText;
    throw new Error(`OpenAI ${res.status}: ${msg}`);
  }
  const raw = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  const draft = parseDraft(raw);
  if (draft.chars > MAX_LINE) {
    throw new Error(`line is ${draft.chars} chars (max ${MAX_LINE}): ${draft.line}`);
  }
  return draft;
}

function labeledCards(p) {
  const who = p.who || 'someone';
  const cards = [];
  const counts = { prompt: 0, voice: 0, video: 0, choice: 0 };
  for (const it of p.items) {
    if (it.kind === 'raw' || it.kind === 'vital') continue;
    if (it.kind === 'text' && (it.q === who || it.q === p.pronouns || isJunkText(it.q))) continue;
    if (it.kind === 'prompt' || it.kind === 'voice' || it.kind === 'video' || it.kind === 'choice') {
      counts[it.kind]++;
      cards.push({
        label: `${it.kind}${counts[it.kind]}`,
        kind: it.kind,
        q: it.q || '',
        a: it.a || (it.opts ? it.opts.join(' | ') : ''),
        raw: it.raw || '',
      });
    }
  }
  let i = 0;
  for (const it of p.items) {
    if (it.kind !== 'text') continue;
    if (it.q === who || it.q === p.pronouns || isJunkText(it.q)) continue;
    i++;
    cards.push({ label: `text${i}`, kind: 'text', q: it.q, a: '', raw: it.raw || it.q });
  }
  return cards;
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function resolveHook(hook, cards) {
  const h = String(hook || '').trim();
  if (!h || !cards.length) return null;
  const exact = cards.find(c => c.label.toLowerCase() === h.toLowerCase());
  if (exact) return exact;
  const hn = norm(h);
  let best = null, bestScore = 0;
  for (const c of cards) {
    const blob = norm(`${c.label} ${c.q} ${c.a} ${c.raw}`);
    let score = 0;
    if (blob === hn || c.label.toLowerCase() === h.toLowerCase()) score = 5;
    else if (hn && blob.includes(hn)) score = 4;
    else if (norm(c.q) && hn.includes(norm(c.q)) && norm(c.q).length >= 6) score = 3;
    else if (norm(c.a) && hn.includes(norm(c.a)) && norm(c.a).length >= 6) score = 2;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
function likeButtons(xml) {
  const { h } = screenSize();
  return allNodes(xml)
    .filter(n => /^Like /i.test(n.desc))
    .filter(n => n.cy > h * 0.16 && n.cy < h * 0.84);
}
function blobMatchesCard(blob, card) {
  const b = norm(blob);
  if (!b) return false;
  const q = norm(card.q);
  const a = norm(card.a);
  const raw = norm(card.raw);
  if (q && q.length >= 6 && b.includes(q)) return true;
  if (a && a.length >= 6 && b.includes(a)) return true;
  if (raw && raw.length >= 8 && b.includes(raw.slice(0, 40))) return true;
  if (q && a && q.length >= 4 && a.length >= 4 && b.includes(q.slice(0, 18)) && b.includes(a.slice(0, 10))) return true;
  return false;
}
function likeForCard(xml, cardNode) {
  const likes = likeButtons(xml);
  if (!likes.length || !cardNode) return null;
  const nearby = likes
    .filter(l => l.cy >= cardNode.top - 60 && l.cy <= cardNode.bot + 240)
    .sort((a, b) => Math.abs(a.cy - (cardNode.bot || cardNode.cy)) - Math.abs(b.cy - (cardNode.bot || cardNode.cy)));
  return nearby[0] || null;
}
function pickFallbackLike(xml) {
  const likes = likeButtons(xml).sort((a, b) => a.top - b.top);
  const order = [
    /^Like prompt$/i,
    /^Like photo prompt$/i,
    /^Like video prompt$/i,
    /^Like voice prompt$/i,
    /^Like photo$/i,
    /^Like /i,
  ];
  for (const re of order) {
    const hit = likes.find(n => re.test(n.desc));
    if (hit) return hit;
  }
  return null;
}

async function findLikeTarget(card) {
  await scrollToTop();
  let xml = await getUI();
  const tryHook = (xml) => {
    if (!card) return null;
    const node = allNodes(xml).find(n => blobMatchesCard(`${n.desc} ${n.text}`, card));
    if (!node) return null;
    const like = likeForCard(xml, node);
    return like ? { like, how: card.label, desc: like.desc } : null;
  };

  let hit = tryHook(xml);
  if (hit) return hit;
  for (let i = 0; i < 16; i++) {
    swipeProfile('down');
    await delay(450);
    xml = await getUI();
    hit = tryHook(xml);
    if (hit) return hit;
  }

  log('Hook card not on screen — falling back to first likeable card');
  await scrollToTop();
  xml = await getUI();
  for (let i = 0; i < 12; i++) {
    const like = pickFallbackLike(xml);
    if (like) return { like, how: `fallback ${like.desc}`, desc: like.desc };
    swipeProfile('down');
    await delay(400);
    xml = await getUI();
  }
  return null;
}

async function commentAndSend(line, kind) {
  const boxHit = await waitFor(/^(Edit comment|Add a comment)$/);
  if (!boxHit) {
    log('No comment field');
    return false;
  }
  tap(boxHit.nodes[0].cx, boxHit.nodes[0].cy);
  await delay(rand(500, 900));
  try {
    typeText(line);
  } catch (e) {
    log(`Type failed — ${e.message.split('\n')[0]}`);
    return false;
  }
  await delay(rand(700, 1200));

  const sendHit = await waitFor(/^Send (priority )?like( with message)?$/i);
  const send = sendHit && sendHit.nodes.filter(n => !/rose/i.test(n.desc))[0];
  if (!send) {
    log('Send button missing');
    return false;
  }
  if (DRY_RUN) {
    log('dry-run — typed, not sent');
    return false;
  }
  tap(send.cx, send.cy);
  log(`Sent${kind ? ` on ${kind}` : ''}`);
  return true;
}

function relPhoto(abs) {
  if (!abs) return '';
  return path.relative(__dirname, path.resolve(abs)).split(path.sep).join('/');
}
function keepPhoto(src, id) {
  if (!src || !id || !fs.existsSync(src)) return '';
  fs.mkdirSync(CROPS_DIR, { recursive: true });
  const dest = path.join(CROPS_DIR, `${id}.png`);
  try {
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  } catch (_) { return relPhoto(src); }
  return relPhoto(dest);
}
function slug(s) {
  return String(s || 'someone').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'someone';
}
function profileAge(p) {
  const v = (p.items || []).find(it => it.kind === 'vital' && /^age$/i.test(it.q));
  if (!v) return '';
  const n = parseInt(v.a, 10);
  return Number.isFinite(n) ? n : String(v.a);
}
function fieldForLog(card, target) {
  if (card && (card.q || card.a)) {
    return card.a ? `${card.label}: ${card.q} — ${card.a}` : `${card.label}: ${card.q}`;
  }
  return (target && (target.how || target.desc)) || '';
}
// Append one object between /*ROWS_START*/ and /*ROWS_END*/ in hinge-log.html.
function appendLog(entry) {
  const file = path.join(__dirname, 'hinge-log.html');
  let html;
  try { html = fs.readFileSync(file, 'utf8'); }
  catch (e) { log(`! log skipped — ${e.message.split('\n')[0]}`); return; }
  const marker = '/*ROWS_END*/';
  const i = html.indexOf(marker);
  if (i < 0) { log('! hinge-log.html missing /*ROWS_END*/ — not logged'); return; }
  const date = new Date().toISOString().slice(0, 10);
  const id = `${date}-${slug(entry.name)}-${Date.now().toString(36).slice(-4)}`;
  const photo = keepPhoto(entry.photo, id) || relPhoto(entry.photo);
  const row = {
    id,
    date,
    name: entry.name || 'someone',
    age: entry.age === '' || entry.age == null ? '' : entry.age,
    field: entry.field || '',
    message: entry.message || '',
    status: 'sent',
    notes: entry.notes || '',
    photo,
  };
  html = html.slice(0, i) + JSON.stringify(row) + ',\n' + html.slice(i);
  fs.writeFileSync(file, html);
  log(`Logged ${row.name} → hinge-log.html`);
}

async function readProfile() {
  log('Reading profile — scrolling for every card type');
  let xml = await scrollToTop();
  const photo = captureFirstPhoto(xml, profileName(xml));
  const items = [];
  const seen = new Set();
  let who = '';
  let pronouns = '';
  let stale = 0;

  const absorb = (src) => {
    let added = 0;
    if (src.who && !who) who = src.who;
    for (const it of src.items) {
      if (it.kind === 'text' && /^(she\/her|he\/him|they\/them)$/i.test(it.q) && !pronouns) {
        pronouns = it.q;
      }
      const k = `${it.kind}|${it.raw || it.q}|${it.a || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
      if (it.kind !== 'raw') added++;
    }
    return added;
  };

  absorb(harvest(xml));
  for (let i = 0; i < 18 && stale < 2; i++) {
    swipeProfile('down');
    await delay(500);
    xml = await getUI();
    const n = absorb(harvest(xml));
    stale = n ? 0 : stale + 1;
    if (VERBOSE) log(`  screen ${i + 1}: +${n} new`);
  }
  return { who, pronouns, items, photo };
}

async function main() {
  loadEnv();
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { log('No authorized device — check `adb devices`.'); process.exitCode = 1; return; }
  if (!TARGET) TARGET = devs[0];

  log(`Connected to ${TARGET}`);
  log('Opening Hinge');
  launchHinge();
  await delay(1200);

  // Discover is the feed. Other tabs (Profile Hub, Matches, …) have no cards.
  {
    const xml = await getUI();
    const disc = findDesc(xml, /^Discover$/)[0];
    const onFeed = findDesc(xml, /^(Like |Skip )/).length > 0;
    if (disc && !onFeed) {
      log('Not on Discover — opening the feed');
      tap(disc.cx, disc.cy);
      await delay(1200);
    }
  }

  let hit = await waitFor(/^(Like |Skip )/);
  for (let t = 0; !hit && t < 2; t++) {
    log('No profile controls yet — scrolling');
    swipeProfile('down');
    hit = await waitFor(/^(Like |Skip )/, 4000);
  }
  if (!hit) { log('Stopped — no profile on screen.'); return; }

  const profile = await readProfile();
  const dump = formatProfile(profile);
  process.stdout.write(dump + '\n');

  if (!NODRAFT) {
    log(`Drafting with ${MODEL}`);
    const draft = await draftOpener(dump);
    log(`hook  ${draft.hook || '(none)'}`);
    log(`${draft.chars} chars`);
    console.log(draft.line);

    const cards = labeledCards(profile);
    const card = resolveHook(draft.hook, cards);
    if (card) log(`Looking for ${card.label}: ${card.q}${card.a ? ' / ' + card.a : ''}`);
    else log('Hook did not match a card — will like whatever is on screen');

    const target = await findLikeTarget(card);
    if (!target) { log('Stopped — no like button found.'); return; }
    log(`Tapping ${target.desc} (${target.how})`);
    tap(target.like.cx, target.like.cy);
    await delay(rand(700, 1200));
    const ok = await commentAndSend(draft.line, target.how);
    if (ok) {
      appendLog({
        name: profile.who || 'someone',
        age: profileAge(profile),
        field: fieldForLog(card, target),
        message: draft.line,
        photo: profile.photo || '',
      });
    }
    log(ok ? 'Done' : `Done — ${DRY_RUN ? 'dry-run, nothing sent' : 'send failed'}`);
    return;
  }
  log('Done — nothing sent');
}

let locked = false;
function lockScreen() {
  if (locked) return;
  locked = true;
  try { log('Locking screen'); sleepScreen(); } catch (_) {}
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { lockScreen(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

function boot() {
  return main()
    .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })
    .finally(() => { lockScreen(); });
}
if (require.main === module) boot();
module.exports = { boot };
