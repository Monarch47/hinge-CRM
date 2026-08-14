#!/usr/bin/env node
/*
 * hinge-read.js — scrape / draft / send helpers. Prefer `node hinge.js`.
 *
 * Usage:
 *   node hinge-read.js                   # no cap, 1–5s gap, like everyone
 *   node hinge-read.js [count]           # stop after `count` likes
 *   DRY_RUN=1 node hinge-read.js         # type the line, don't send (one profile)
 *   NODRAFT=1 node hinge-read.js         # scrape only (one profile)
 *   SERIAL=192.168.29.4:5555 node hinge-read.js
 *   VERBOSE=1 node hinge-read.js         # also print every raw node
 *
 * Env vars (same as hinge-opener.js):
 *   NUM_LIKES  how many to send            (default: no cap, or first CLI arg)
 *   MIN_GAP    min seconds between profiles (default 1)
 *   MAX_GAP    max seconds between profiles (default 5)
 *   SKIP_MIN   like this many then pass one, low end   (default 6)
 *   SKIP_MAX   ...high end                             (default 0 = never pass)
 *   DRY_RUN=1  self-test: sends nothing
 *   NO_LOCK=1  leave the screen on at exit (default: put it to sleep / lock)
 *   LOAD_TIMEOUT  ms to wait for a screen to load, for lag/slow net (default 12000)
 *   SHOTS_DIR  folder for send-sheet screenshots  (default screenshots/)
 *   ADB        path to adb                 (default: auto-detect via $PATH + common spots)
 *   SERIAL     adb -s target               (default: first authorized device)
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
const MODEL   = process.env.MODEL || 'gpt-5.6';
const MAX_LINE = 255;
// No cap by default — runs until Hinge runs out of profiles/likes. Pass a count
// (CLI arg or NUM_LIKES) to cap it.
const NUM     = (process.argv[2] || process.env.NUM_LIKES)
  ? parseInt(process.argv[2] || process.env.NUM_LIKES, 10) : Infinity;
const MIN_GAP = parseFloat(process.env.MIN_GAP || '1');
const MAX_GAP = parseFloat(process.env.MAX_GAP || '5');
const SKIP_MIN = parseInt(process.env.SKIP_MIN || '6', 10);
const SKIP_MAX = parseInt(process.env.SKIP_MAX || '0', 10);  // 0 = like everyone
const DRY_RUN = process.env.DRY_RUN === '1';
const NO_LOCK = process.env.NO_LOCK === '1';
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

/* ---- debug journal -------------------------------------------------------
 * One JSONL file per run under logs/ (gitignored — it holds scraped profile
 * text and full screen dumps). Console stays readable; everything else lands
 * here so a failure can be reconstructed afterwards.
 * LOG_DIR=  where to write        DEBUG_LOG=0  turn it off
 */
const LOG_DIR = process.env.LOG_DIR || 'logs';
const DEBUG_LOG = process.env.DEBUG_LOG !== '0';
const RUN_ID = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
let LOG_FILE = null;
let LAST_XML = '';        // most recent dump, so failures can log the screen
let PROFILE_N = 0;
function dbg(event, data = {}) {
  if (!DEBUG_LOG) return;
  try {
    if (!LOG_FILE) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      LOG_FILE = path.join(LOG_DIR, `run-${RUN_ID}.jsonl`);
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), profile: PROFILE_N, event, ...data }) + '\n');
  } catch (_) {}
}
// Everything currently on screen, flattened — the bit that actually explains
// "why did it stop here".
function screenNodes(xml) {
  if (!xml) return [];
  try {
    return allNodes(xml).map(n => ({
      cls: n.cls, desc: n.desc || undefined, text: n.text || undefined,
      b: [n.left, n.top, n.right, n.bot],
    }));
  } catch (_) { return []; }
}
function dbgFail(event, data = {}) {
  const xml = LAST_XML;
  let raw = '';
  if (DEBUG_LOG && xml) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      raw = path.join(LOG_DIR, `run-${RUN_ID}-p${PROFILE_N}-${event}.xml`);
      fs.writeFileSync(raw, xml);
    } catch (_) { raw = ''; }
  }
  dbg(event, { ...data, ok: false, xmlFile: raw || undefined, screen: screenNodes(xml) });
}

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

function adbOnce(args, wantOut = false, timeoutMs = 0) {
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
// Wi-Fi adb drops out on its own (screen off, roaming, doze). One silent
// reconnect beats losing a whole run.
const DROPPED = /device\s+'?[^']*'?\s+(?:not found|offline)|device offline|no devices\/emulators found|closed/i;
function adb(args, wantOut = false, timeoutMs = 0) {
  try {
    return adbOnce(args, wantOut, timeoutMs);
  } catch (e) {
    if (!TARGET.includes(':') || !DROPPED.test(e.message)) throw e;
    try {
      execFileSync(ADB, ['connect', TARGET], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
    } catch (_) {}
    return adbOnce(args, wantOut, timeoutMs);
  }
}
const wake = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {} };
const sleepScreen = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']); } catch (_) {} };
const tap = (x, y) => adb(['shell', 'input', 'tap', `${Math.round(x)}`, `${Math.round(y)}`]);
const back = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']); } catch (_) {} };
const swipe = (x1, y1, x2, y2, d = 450) =>
  adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, d].map(v => `${Math.round(v)}`)]);

// Grep on the device — a full `dumpsys window` is megabytes over Wi-Fi.
const keyguardUp = () => {
  try {
    return /isKeyguardShowing=true|mShowingLockscreen=true/.test(
      adb(['shell', 'dumpsys window | grep -iE "isKeyguardShowing|mShowingLockscreen"'], true, 8000));
  } catch (_) { return false; }
};
// The screen times out mid-run and `wm dismiss-keyguard` alone does not clear
// a swipe lock, so swipe it away and confirm. Without this the run just sees
// "no profile controls" and quits.
async function unlock() {
  wake();
  try { adb(['shell', 'wm', 'dismiss-keyguard']); } catch (_) {}
  await delay(400);
  let up = keyguardUp();
  for (let i = 0; i < 3 && up; i++) {
    const { w, h } = screenSize();
    try { swipe(w / 2, h * 0.80, w / 2, h * 0.25, 300); } catch (_) {}
    await delay(600);
    up = keyguardUp();
  }
  if (up) { log('Screen is locked and needs a PIN — unlock the phone'); dbg('keyguard-stuck'); }
  return !up;
}
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
// Travels 46% of the viewport per swipe, up from 32%. Anything under 100%
// still shows every pixel in some dump, so coverage is unchanged — but it
// takes ~a third fewer dumps to read a profile, and a dump costs 2.6s.
// Duration scales with the distance so the fling velocity stays the same,
// which is what keeps the swipe-from-top index reproducible.
function swipeProfile(dir) {
  const { w, h } = screenSize();
  const x = w / 2, a = h * 0.76, b = h * 0.30;
  if (dir === 'down') swipe(x, a, x, b, 600);
  else                swipe(x, b, x, a, 600);
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
  try {
    adb(['shell', 'ime', 'enable', 'com.android.adbkeyboard/.AdbIME']);
    adb(['shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
    adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text, 'utf8').toString('base64')]);
  } finally {
    // Always hand the keyboard back, even if the broadcast blew up.
    if (prev && !/adbkeyboard/.test(prev)) { try { adb(['shell', 'ime', 'set', prev]); } catch (_) {} }
  }
}
// `adb shell input text …` is re-parsed by the device's sh, so a bare `;`
// ends the command and `'` opens a quote. Backslash-escape every shell
// metachar. Runs after the input-text encoding (%%, %s) so those survive.
const SH_META = /[\\;'"&|()<>$`*?~!#[\]{}^\n\t ]/g;
function encodeForInputText(s) {
  return s.replace(/%/g, '%%').replace(/ /g, '%s').replace(SH_META, c => '\\' + c);
}
function typeViaInputText(text) {
  const CHUNK = 90;
  for (let i = 0; i < text.length; i += CHUNK) {
    adb(['shell', 'input', 'text', encodeForInputText(text.slice(i, i + CHUNK))]);
  }
}
function typeText(text) {
  const raw = String(text);
  // ADBKeyboard goes over a base64 broadcast — no shell, no escaping, keeps
  // Unicode. Prefer it for every line, not just the ones with emoji.
  if (hasAdbKeyboard()) {
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

// exec-out to /dev/tty and dump-to-file+cat benchmarked the same on this
// device (~2.6s either way — it is uiautomator that is slow, not the
// transfer), so keep the dump+cat path that is known to behave.
async function getUI() {
  for (let i = 0; i < 4; i++) {
    try {
      adb(['shell', 'uiautomator', 'dump', '/sdcard/hinge_ui.xml'], false, 8000);
      const xml = adb(['shell', 'cat', '/sdcard/hinge_ui.xml'], true, 5000);
      if (xml && xml.includes('<hierarchy')) { LAST_XML = xml; return xml; }
    } catch (e) {
      dbg('getUI-retry', { try: i + 1, err: e.message.split('\n')[0] });
    }
    await delay(700);
  }
  dbg('getUI-failed');
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

function cleanName(n) {
  n = String(n || '').trim();
  if (!n || /^(like|unlike|skip|play|pause|next)$/i.test(n)) return '';
  return n;
}
function profileName(xml) {
  const skip = findDesc(xml, /^Skip /)[0];
  const fromSkip = skip ? cleanName(skip.desc.replace(/^Skip\s+/i, '')) : '';
  // One-letter Skip labels ("Skip N") are usually a truncated a11y string.
  if (fromSkip.length >= 2) return fromSkip;
  for (const node of findDesc(xml, /(?:photo|video)$/i)) {
    const n = cleanName(node.desc
      .replace(/[’'`]s\s+(photo|video)$/i, '')
      .replace(/\s+(photo|video)$/i, ''));
    if (n.length >= 2) return n;
  }
  return fromSkip;
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
// Card kinds that carry their own Like heart, so they can be hooked.
const LIKEABLE = /^(prompt|voice|video|choice)$/;
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
// A swipe costs ~0.5s, a UI dump ~2.6s. Swipe blind to the top first and
// confirm with a single dump, instead of dumping before every swipe.
async function scrollToTop() {
  for (let i = 0; i < 8; i++) {
    swipeProfile('up');
    await delay(180);
  }
  let xml = await getUI();
  if (xml && atProfileTop(xml)) return xml;
  for (let i = 0; i < 6; i++) {
    swipeProfile('up');
    await delay(250);
    xml = await getUI();
    if (xml && atProfileTop(xml)) return xml;
  }
  return xml || getUI();
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
        swipeAt: it.likeSwipe !== undefined ? it.likeSwipe : it.swipe,
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

// opts.alreadyAtTop — caller has just scrolled to the top, skip doing it again.
// opts.swipeAt     — swipe count from the top where this card's Like heart was
//                    reachable during the scrape. Blind-swipe straight there
//                    and dump once, instead of dumping down the whole profile.
// Coordinates captured during the scrape are never reused — they are stale the
// moment anything scrolls, so every tap target comes from a fresh dump.
async function findLikeTarget(card, opts = {}) {
  const tryHook = (xml) => {
    if (!card || !xml) return null;
    const node = allNodes(xml).find(n => blobMatchesCard(`${n.desc} ${n.text}`, card));
    if (!node) return null;
    const like = likeForCard(xml, node);
    return like ? { like, how: card.label, desc: like.desc } : null;
  };

  let xml = null;
  const jumpTo = card && Number.isInteger(opts.swipeAt) ? opts.swipeAt : null;
  if (jumpTo !== null) {
    if (!opts.alreadyAtTop) await scrollToTop();
    for (let i = 0; i < jumpTo; i++) {
      swipeProfile('down');
      await delay(200);
    }
    xml = await getUI();
    let hit = tryHook(xml);
    if (hit) { dbg('fast-jump', { swipeAt: jumpTo, nudges: 0, hit: true }); return hit; }
    // Landing can be off by a screen — nudge rather than restart.
    for (let i = 0; i < 3; i++) {
      swipeProfile('down');
      await delay(200);
      xml = await getUI();
      hit = tryHook(xml);
      if (hit) { dbg('fast-jump', { swipeAt: jumpTo, nudges: i + 1, hit: true }); return hit; }
    }
    log('Fast jump missed — walking the profile');
    dbg('fast-jump', { swipeAt: jumpTo, nudges: 3, hit: false });
    xml = await scrollToTop();
  } else {
    xml = opts.alreadyAtTop ? await getUI() : await scrollToTop();
  }

  let hit = tryHook(xml);
  if (hit) return hit;
  for (let i = 0; i < 16; i++) {
    swipeProfile('down');
    await delay(200);
    xml = await getUI();
    hit = tryHook(xml);
    if (hit) return hit;
  }

  log('Hook card not on screen — falling back to first likeable card');
  dbgFail('hook-not-found', { card: card ? { label: card.label, q: card.q, swipeAt: card.swipeAt } : null });
  xml = await scrollToTop();
  for (let i = 0; i < 12; i++) {
    const like = pickFallbackLike(xml);
    if (like) return { like, how: `fallback ${like.desc}`, desc: like.desc };
    swipeProfile('down');
    await delay(200);
    xml = await getUI();
  }
  return null;
}

async function commentAndSend(line, kind) {
  const boxHit = await waitFor(/^(Edit comment|Add a comment)$/);
  if (!boxHit) {
    log('No comment field');
    dbgFail('no-comment-field', { kind });
    return false;
  }
  tap(boxHit.nodes[0].cx, boxHit.nodes[0].cy);
  await delay(rand(500, 900));
  try {
    typeText(line);
  } catch (e) {
    log(`Type failed — ${e.message.split('\n')[0]}`);
    dbgFail('type-failed', { err: e.message, line, via: hasAdbKeyboard() ? 'adbkeyboard' : 'input-text' });
    return false;
  }
  await delay(rand(700, 1200));

  const sendHit = await waitFor(/^Send (priority )?like( with message)?$/i);
  const send = sendHit && sendHit.nodes.filter(n => !/rose/i.test(n.desc))[0];
  if (!send) {
    log('Send button missing');
    dbgFail('send-button-missing', { kind });
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

// seedXml: the dump waitForProfile already took. A fresh card opens at the
// top, so reuse it rather than paying a scroll-to-top that does nothing.
async function readProfile(seedXml) {
  log('Reading profile — scrolling for every card type');
  let xml = seedXml && atProfileTop(seedXml) ? seedXml : await scrollToTop();
  const photo = captureFirstPhoto(xml, profileName(xml));
  const items = [];
  const seen = new Set();
  let who = '';
  let pronouns = '';
  let stale = 0;

  const absorb = (src, at) => {
    let added = 0;
    if (src.who && !who) who = src.who;
    for (const it of src.items) {
      if (it.kind === 'text' && /^(she\/her|he\/him|they\/them)$/i.test(it.q) && !pronouns) {
        pronouns = it.q;
      }
      const k = `${it.kind}|${it.raw || it.q}|${it.a || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (LIKEABLE.test(it.kind)) it.swipe = at;
      items.push(it);
      if (it.kind !== 'raw') added++;
    }
    return added;
  };

  // A card is often on screen a swipe before its Like heart enters the
  // tappable band, so remember the swipe where the heart was actually
  // reachable — that is the one findLikeTarget jumps back to.
  const noteLikeSwipe = (xml, at) => {
    const pending = items.filter(it => LIKEABLE.test(it.kind) && it.likeSwipe === undefined);
    if (!pending.length) return;
    const nodes = allNodes(xml);
    for (const it of pending) {
      const node = nodes.find(n => it.raw && (n.desc === it.raw || n.text === it.raw));
      if (node && likeForCard(xml, node)) it.likeSwipe = at;
    }
  };

  absorb(harvest(xml), 0);
  noteLikeSwipe(xml, 0);
  for (let i = 0; i < 18 && stale < 2; i++) {
    swipeProfile('down');
    await delay(200);
    xml = await getUI();
    const n = absorb(harvest(xml), i + 1);
    noteLikeSwipe(xml, i + 1);
    stale = n ? 0 : stale + 1;
    if (VERBOSE) log(`  screen ${i + 1}: +${n} new`);
  }
  return { who, pronouns, items, photo };
}

async function waitForProfile() {
  let hit = await waitFor(/^(Like |Skip )/);
  for (let t = 0; !hit && t < 2; t++) {
    log('No profile controls yet — scrolling');
    // Could be a locked screen rather than an empty feed — cheap to rule out.
    if (t === 0) await unlock();
    swipeProfile('down');
    hit = await waitFor(/^(Like |Skip )/, 4000);
  }
  if (!hit) dbgFail('no-profile-controls');
  return hit;
}

async function skipProfile() {
  let xml = await getUI();
  let sk = findDesc(xml, /^Skip /)[0];
  // Skip is a floating control — if it is missing we are usually mid-scroll
  // or a sheet is still settling, not out of cards. Give it a few tries.
  for (let i = 0; !sk && i < 3; i++) {
    swipeProfile('up');
    await delay(450);
    xml = await getUI();
    sk = findDesc(xml, /^Skip /)[0];
  }
  if (!sk) {
    log('Skip button missing');
    dbgFail('skip-button-missing');
    return false;
  }
  log(`Skipping ${profileName(xml) || sk.desc.replace(/^Skip\s+/i, '') || 'someone'}`);
  tap(sk.cx, sk.cy);
  return true;
}

// The like/comment sheet. Two blind backs used to over- or under-shoot;
// back only while the sheet is actually still up.
const SHEET_RE = /^(Edit comment|Add a comment|Send (priority )?like( with message)?)$/i;
async function bailSheet() {
  for (let i = 0; i < 4; i++) {
    const xml = await getUI();
    if (!xml || !findDesc(xml, SHEET_RE).length) return true;
    back();
    await delay(550);
  }
  log('Comment sheet would not close');
  dbgFail('sheet-stuck');
  return false;
}
// Close whatever is on top and get back to a card with Like/Skip on it.
async function recoverToFeed() {
  await bailSheet();
  let hit = await waitFor(/^(Like |Skip )/, 6000);
  for (let t = 0; !hit && t < 2; t++) {
    swipeProfile('up');
    await delay(450);
    hit = await waitFor(/^(Like |Skip )/, 4000);
  }
  return !!hit;
}

function logTiming(t0, T) {
  const s = ms => `${(ms / 1000).toFixed(1)}s`;
  const parts = ['scrape', 'draft', 'find', 'send']
    .filter(k => T[k] !== undefined)
    .map(k => `${k} ${s(T[k])}`);
  log(`timing  ${s(Date.now() - t0)} total${parts.length ? `  ·  ${parts.join('  ·  ')}` : ''}`);
}

async function handleOneProfile() {
  const t0 = Date.now();
  const T = {};
  PROFILE_N++;
  dbg('profile-start');
  const hit = await waitForProfile();
  if (!hit) { dbg('outcome', { result: 'none' }); return 'none'; }

  let mark = Date.now();
  const profile = await readProfile(hit.xml);
  const dump = formatProfile(profile);
  process.stdout.write(dump + '\n');
  T.scrape = Date.now() - mark;
  dbg('scraped', {
    who: profile.who, age: profileAge(profile), ms: T.scrape,
    text: dump,
    items: profile.items.filter(it => it.kind !== 'raw'),
  });

  if (NODRAFT) { logTiming(t0, T); dbg('outcome', { result: 'scraped', T }); return 'scraped'; }

  // The scrape ends at the bottom of the profile and the model takes a few
  // seconds — fire the request first, then scroll back up while it is in
  // flight instead of doing the two one after the other.
  mark = Date.now();
  log(`Drafting with ${MODEL}`);
  const pending = draftOpener(dump).then(d => ({ d }), e => ({ e }));
  await scrollToTop();
  const got = await pending;
  T.draft = Date.now() - mark;
  if (got.e) {
    log(`Draft failed — ${got.e.message.split('\n')[0]}`);
    dbgFail('draft-failed', { err: got.e.message, model: MODEL, ms: T.draft });
    await skipProfile();
    logTiming(t0, T);
    dbg('outcome', { result: 'failed', why: 'draft', T });
    return 'failed';
  }
  const draft = got.d;
  log(`hook  ${draft.hook || '(none)'}`);
  log(`${draft.chars} chars`);
  console.log(draft.line);

  const cards = labeledCards(profile);
  const card = resolveHook(draft.hook, cards);
  if (card) log(`Looking for ${card.label}: ${card.q}${card.a ? ' / ' + card.a : ''}`);
  else log('Hook did not match a card — will like whatever is on screen');
  dbg('drafted', {
    ms: T.draft, hook: draft.hook, chars: draft.chars, line: draft.line,
    matched: card ? { label: card.label, swipeAt: card.swipeAt } : null,
    cards: cards.map(c => ({ label: c.label, swipeAt: c.swipeAt, q: c.q, a: c.a })),
  });

  mark = Date.now();
  const target = await findLikeTarget(card, {
    alreadyAtTop: true,
    swipeAt: card ? card.swipeAt : undefined,
  });
  T.find = Date.now() - mark;
  if (!target) {
    log('No like button found — skipping');
    dbgFail('no-like-button', { ms: T.find, card: card ? card.label : null });
    await skipProfile();
    logTiming(t0, T);
    dbg('outcome', { result: 'failed', why: 'no-like-button', T });
    return 'failed';
  }
  dbg('found-target', { ms: T.find, how: target.how, desc: target.desc, at: [target.like.cx, target.like.cy] });
  log(`Tapping ${target.desc} (${target.how})`);
  mark = Date.now();
  tap(target.like.cx, target.like.cy);
  await delay(rand(700, 1200));
  const ok = await commentAndSend(draft.line, target.how);
  T.send = Date.now() - mark;
  logTiming(t0, T);
  if (ok) {
    appendLog({
      name: profile.who || 'someone',
      age: profileAge(profile),
      field: fieldForLog(card, target),
      message: draft.line,
      photo: profile.photo || '',
    });
    dbg('outcome', { result: 'sent', how: target.how, line: draft.line, T });
    return 'sent';
  }
  if (DRY_RUN) {
    // Nothing was sent — just close the sheet so the feed is usable after.
    await bailSheet();
    dbg('outcome', { result: 'dry', line: draft.line, T });
    return 'dry';
  }
  log('Send failed — backing out');
  dbgFail('send-failed', { how: target.how, line: draft.line, ms: T.send });
  const back = await recoverToFeed();
  if (back) await skipProfile();
  else log('Could not get back to the feed');
  dbg('outcome', { result: 'failed', why: 'send', recovered: back, T });
  return 'failed';
}

async function main() {
  loadEnv();
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { log('No authorized device — check `adb devices`.'); process.exitCode = 1; return; }
  if (!TARGET) TARGET = devs[0];

  const cap = NUM === Infinity ? 'until profiles run out' : `${NUM} like${NUM === 1 ? '' : 's'} then stop`;
  const pass = SKIP_MAX <= 0 ? 'liking everyone' : `pass 1 after every ${SKIP_MIN}–${SKIP_MAX} likes`;
  log(`Connected to ${TARGET}`);
  dbg('run-start', {
    target: TARGET, model: MODEL, num: NUM === Infinity ? null : NUM,
    dryRun: DRY_RUN, noDraft: NODRAFT, minGap: MIN_GAP, maxGap: MAX_GAP,
    skipMin: SKIP_MIN, skipMax: SKIP_MAX, adbKeyboard: hasAdbKeyboard(),
  });
  if (DEBUG_LOG) log(`Debug journal → ${path.join(LOG_DIR, `run-${RUN_ID}.jsonl`)}`);
  if (NODRAFT) log('scrape only — one profile, nothing sent');
  else if (DRY_RUN) log('dry-run — type on one profile, send nothing');
  else log(`${cap} · ${MIN_GAP}–${MAX_GAP}s between likes · ${pass}`);

  log('Opening Hinge');
  await unlock();
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

  if (NODRAFT || DRY_RUN) {
    const result = await handleOneProfile();
    if (result === 'none') log('Stopped — no profile on screen.');
    else if (result === 'scraped') log('Done — nothing sent');
    else if (result === 'dry') log('Done — dry-run, nothing sent');
    else log('Done');
    dbg('run-end', { result });
    if (DEBUG_LOG && LOG_FILE) log(`Debug journal → ${LOG_FILE}`);
    return;
  }

  // SKIP_MAX=0 → never pass; otherwise like SKIP_MIN..SKIP_MAX profiles, then pass one.
  const nextRun = () => SKIP_MAX <= 0 ? Infinity
    : SKIP_MIN + Math.floor(Math.random() * (SKIP_MAX - SKIP_MIN + 1));
  let likesBeforeSkip = nextRun();
  let sent = 0, passed = 0, errors = 0, consecErr = 0;
  while (sent < NUM) {
    await unlock();
    if (likesBeforeSkip <= 0) {
      const hit = await waitForProfile();
      if (!hit) {
        log('Stopped — no profile on screen (out of cards, a popup, or paywall).');
        break;
      }
      if (await skipProfile()) passed++;
      likesBeforeSkip = nextRun();
      await delay(rand(MIN_GAP, MAX_GAP) * 1000);
      continue;
    }

    // A thrown adb/parse error is one bad profile, not the end of the run.
    let result;
    try {
      result = await handleOneProfile();
    } catch (e) {
      log(`Profile failed — ${e.message.split('\n')[0]}`);
      dbgFail('threw', { err: e.message, stack: e.stack });
      try { await recoverToFeed(); } catch (_) {}
      result = 'failed';
    }
    if (result === 'none') {
      log('Stopped — no profile on screen (out of cards, a popup, or paywall).');
      break;
    }
    if (result === 'sent') {
      sent++;
      likesBeforeSkip--;
      consecErr = 0;
      log(`Sent ${sent}${NUM === Infinity ? '' : '/' + NUM}`);
    } else {
      errors++;
      consecErr++;
      if (consecErr >= 5) {
        log('Stopped — 5 failures in a row (paywall / stuck UI / out of likes).');
        break;
      }
    }
    if (sent >= NUM) break;
    await delay(rand(MIN_GAP, MAX_GAP) * 1000);
  }

  const bits = [`${sent} sent`];
  if (passed) bits.push(`${passed} skipped`);
  if (errors) bits.push(`${errors} failed`);
  log(`Done — ${bits.join(', ')}`);
  dbg('run-end', { sent, passed, errors });
  if (DEBUG_LOG && LOG_FILE) log(`Debug journal → ${LOG_FILE}`);
}

let locked = false;
function lockScreen() {
  if (locked || NO_LOCK) return;
  locked = true;
  try { log('Locking screen'); sleepScreen(); } catch (_) {}
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { lockScreen(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

function boot() {
  return main()
    .catch(e => {
      console.error('Fatal:', e.message);
      dbgFail('fatal', { err: e.message, stack: e.stack });
      process.exitCode = 1;
    })
    .finally(() => { lockScreen(); });
}
if (require.main === module) boot();
module.exports = { boot };
