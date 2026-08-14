#!/usr/bin/env node
/*
 * hinge-speed-probe.js — read-only timing probe for the hinge.js slowness.
 *
 * NEVER taps Like, Send, Skip, or Rose. It only swipes and dumps UI.
 * Leave the phone on a Hinge Discover profile and run:
 *
 *   node hinge-speed-probe.js
 *   SERIAL=192.168.29.4:5555 node hinge-speed-probe.js
 *
 * Measures:
 *   1. `adb exec-out uiautomator dump /dev/tty`  vs  dump-to-sdcard + cat
 *   2. blind scrollToTop (swipe N times, dump once)
 *   3. swipe-indexed scrape (which swipe-from-top each card appears on)
 *   4. find-hook simulation (blind-swipe straight to a card, one dump)
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ---------- adb plumbing (mirrors hinge-read.js) ---------- */

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
const ADB = process.env.ADB || findAdb();
let TARGET = process.env.SERIAL || '';

const delay = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const secs = ms => `${(ms / 1000).toFixed(1)}s`;

function adb(args, wantOut = false, timeoutMs = 0) {
  const full = TARGET ? ['-s', TARGET, ...args] : args;
  return execFileSync(ADB, full, {
    encoding: 'utf8',
    stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'pipe'],
    timeout: timeoutMs || undefined,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
}
const swipe = (x1, y1, x2, y2, d = 420) =>
  adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, d].map(v => `${Math.round(v)}`)]);

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

/* ---------- the two dump paths ---------- */

// `uiautomator dump /dev/tty` prints the XML then a trailing
// "UI hierchary dumped to: /dev/tty" (sic) line. Cut everything
// outside <hierarchy>…</hierarchy>.
function cleanDump(raw) {
  const s = String(raw || '');
  const start = s.indexOf('<hierarchy');
  if (start < 0) return '';
  const end = s.lastIndexOf('</hierarchy>');
  return end > start ? s.slice(start, end + '</hierarchy>'.length) : s.slice(start);
}
function dumpStdout() {
  return cleanDump(adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], true, 10000));
}
function dumpCat() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/hinge_ui.xml'], false, 10000);
  return adb(['shell', 'cat', '/sdcard/hinge_ui.xml'], true, 6000);
}

let USE_STDOUT = false;   // decided by step 1
let dumpCount = 0;
async function getUI() {
  for (let i = 0; i < 4; i++) {
    try {
      const xml = USE_STDOUT ? dumpStdout() : dumpCat();
      if (xml && xml.includes('<hierarchy')) { dumpCount++; return xml; }
    } catch (_) {}
    await delay(700);
  }
  return '';
}

/* ---------- XML parsing (copied from hinge-read.js) ---------- */

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
function isChrome(n) { return isControlLabel(n.desc) || isControlLabel(n.text); }
function parsePrompt(desc) {
  const m = /^Prompt:\s*([\s\S]+)$/i.exec(desc || '');
  if (!m) return null;
  const rest = m[1];
  const cut = rest.search(/\.\s*Answer:\s*/);
  if (cut >= 0) return { q: rest.slice(0, cut).trim(), a: rest.slice(cut).replace(/^\.\s*Answer:\s*/, '').trim() };
  const cut2 = rest.search(/\s+Answer:\s*/);
  if (cut2 >= 0) return { q: rest.slice(0, cut2).trim(), a: rest.slice(cut2).replace(/^\s*Answer:\s*/, '').trim() };
  return { q: rest.trim(), a: '' };
}

// Just the card kinds the hook resolver cares about — prompt/voice/video/choice.
function harvestCards(xml) {
  const { h } = screenSize();
  const ns = allNodes(xml).filter(n => n.bot > 160 && n.top < h * 0.91);
  const items = [];
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
  const buttons = ns.filter(n => n.cls === 'Button' && n.text && !isChrome(n) && n.text.length < 80);
  if (buttons.length >= 2 && buttons.length <= 4) {
    const opts = buttons.map(b => b.text.trim());
    items.push({ kind: 'choice', q: '', a: opts.join(' | '), raw: opts.join(' | '), opts });
  }
  return items;
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
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
function likeButtons(xml) {
  const { h } = screenSize();
  return allNodes(xml)
    .filter(n => /^Like /i.test(n.desc))
    .filter(n => n.cy > h * 0.16 && n.cy < h * 0.84);
}
function likeForCard(xml, cardNode) {
  const likes = likeButtons(xml);
  if (!likes.length || !cardNode) return null;
  return likes
    .filter(l => l.cy >= cardNode.top - 60 && l.cy <= cardNode.bot + 240)
    .sort((a, b) => Math.abs(a.cy - (cardNode.bot || cardNode.cy)) - Math.abs(b.cy - (cardNode.bot || cardNode.cy)))[0] || null;
}
function tryHook(xml, card) {
  if (!card) return null;
  const node = allNodes(xml).find(n => blobMatchesCard(`${n.desc} ${n.text}`, card));
  if (!node) return null;
  const like = likeForCard(xml, node);
  return like ? { like, node, desc: like.desc } : null;
}
const atProfileTop = xml => findDesc(xml, /^(Dating preferences|Age filter options)$/).length > 0;

/* ---------- step 1: which dump path? ---------- */

async function step1() {
  console.log('\n=== 1. getUI paths ===');
  const out = { stdoutMs: 0, stdoutOk: false, catMs: 0, catOk: false };

  // stdout
  {
    const t = Date.now();
    let xml = '', err = '';
    try { xml = dumpStdout(); }
    catch (e) { err = String(e.message || e).split('\n')[0]; }
    out.stdoutMs = Date.now() - t;
    out.stdoutOk = xml.includes('<hierarchy');
    console.log(`  exec-out dump /dev/tty  ${out.stdoutMs}ms  hierarchy=${out.stdoutOk ? 'yes' : 'no'}${err ? `  err=${err}` : ''}`);
    console.log(`    ${JSON.stringify((xml || '').slice(0, 200))}`);
  }

  // dump + cat
  {
    const t = Date.now();
    let xml = '', err = '';
    try { xml = dumpCat(); }
    catch (e) { err = String(e.message || e).split('\n')[0]; }
    out.catMs = Date.now() - t;
    out.catOk = String(xml).includes('<hierarchy');
    console.log(`  dump /sdcard + cat      ${out.catMs}ms  hierarchy=${out.catOk ? 'yes' : 'no'}${err ? `  err=${err}` : ''}`);
    console.log(`    ${JSON.stringify(String(xml || '').slice(0, 200))}`);
  }

  USE_STDOUT = out.stdoutOk && (!out.catOk || out.stdoutMs <= out.catMs * 1.15);
  console.log(`  -> using ${USE_STDOUT ? 'exec-out stdout' : 'dump+cat'} for the rest of the probe`);
  if (!out.stdoutOk && !out.catOk) throw new Error('neither dump path returned a <hierarchy> — is the phone awake on Hinge?');
  return out;
}

/* ---------- step 2: blind scrollToTop ---------- */

async function blindScrollToTop(blindSwipes = 8) {
  for (let i = 0; i < blindSwipes; i++) {
    swipeProfile('up');
    await delay(180);
  }
  let xml = await getUI();
  if (xml && atProfileTop(xml)) return { xml, atTop: true, extra: 0 };
  for (let i = 0; i < 5; i++) {
    swipeProfile('up');
    await delay(250);
    xml = await getUI();
    if (xml && atProfileTop(xml)) return { xml, atTop: true, extra: i + 1 };
  }
  return { xml, atTop: false, extra: 5 };
}

async function step2() {
  console.log('\n=== 2. blind scrollToTop ===');
  const t = Date.now();
  const r = await blindScrollToTop(8);
  const ms = Date.now() - t;
  console.log(`  ${ms}ms  atTop=${r.atTop ? 'yes' : 'no'}  extraDumpCycles=${r.extra}`);
  return { ms, atTop: r.atTop, xml: r.xml };
}

/* ---------- step 3: swipe-indexed scrape ---------- */

async function step3(topXml) {
  console.log('\n=== 3. swipe-indexed scrape ===');
  const t = Date.now();
  const counts = { prompt: 0, voice: 0, video: 0, choice: 0 };
  const seen = new Set();
  const map = [];
  let stale = 0;

  const absorb = (xml, swipeFromTop) => {
    let added = 0;
    for (const it of harvestCards(xml)) {
      const k = `${it.kind}|${it.raw || it.q}|${it.a || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      counts[it.kind]++;
      map.push({ label: `${it.kind}${counts[it.kind]}`, kind: it.kind, q: it.q || it.a, a: it.a, raw: it.raw, swipeFromTop });
      added++;
    }
    return added;
  };

  let xml = topXml && topXml.includes('<hierarchy') ? topXml : await getUI();
  absorb(xml, 0);
  for (let i = 0; i < 18 && stale < 2; i++) {
    swipeProfile('down');
    await delay(200);
    xml = await getUI();
    const n = absorb(xml, i + 1);
    stale = n ? 0 : stale + 1;
  }
  const ms = Date.now() - t;

  for (const c of map) {
    console.log(`  swipe ${String(c.swipeFromTop).padStart(2)}  ${c.label.padEnd(8)} ${JSON.stringify(String(c.q).slice(0, 60))}`);
  }
  console.log(`  ${ms}ms  ${map.length} cards`);
  return { ms, map };
}

/* ---------- step 4: find-hook simulation ---------- */

async function step4(map) {
  console.log('\n=== 4. find-hook simulation ===');
  const prompts = map.filter(c => c.kind !== 'text');
  const card = prompts.length ? prompts[prompts.length - 1] : null;
  if (!card) {
    console.log('  no card to target — skipping');
    return { ms: 0, hit: false, card: null };
  }
  console.log(`  target ${card.label} @ swipe ${card.swipeFromTop}: ${JSON.stringify(String(card.q).slice(0, 60))}`);

  const t = Date.now();
  await blindScrollToTop(8);
  for (let i = 0; i < card.swipeFromTop; i++) {
    swipeProfile('down');
    await delay(200);
  }
  let xml = await getUI();
  let hit = tryHook(xml, card);
  const exactMs = Date.now() - t;
  console.log(`  exact landing (swipe ${card.swipeFromTop}): ${exactMs}ms  hit=${hit ? 'yes' : 'no'}${hit ? `  (${hit.desc})` : ''}`);

  // A card first seen at swipe N sits near the bottom of that screen, so its
  // Like button can fall outside the tappable band. Nudge down a couple.
  let nudges = 0;
  while (!hit && nudges < 3) {
    nudges++;
    swipeProfile('down');
    await delay(200);
    xml = await getUI();
    hit = tryHook(xml, card);
  }
  const ms = Date.now() - t;
  if (nudges) console.log(`  after ${nudges} nudge swipe(s): ${ms}ms  hit=${hit ? 'yes' : 'no'}${hit ? `  (${hit.desc})` : ''}`);

  if (hit) return { ms, hit: true, card, nudges, fallbackMs: 0 };

  // Miss — measure the dump-every-swipe walk for comparison.
  console.log('  miss — measuring dump-every-swipe fallback');
  const t2 = Date.now();
  await blindScrollToTop(8);
  let xml2 = await getUI();
  let hit2 = tryHook(xml2, card);
  for (let i = 0; i < 16 && !hit2; i++) {
    swipeProfile('down');
    await delay(200);
    xml2 = await getUI();
    hit2 = tryHook(xml2, card);
  }
  const ms2 = Date.now() - t2;
  console.log(`  fallback walk: ${ms2}ms  hit=${hit2 ? 'yes' : 'no'}`);
  return { ms, hit: false, card, fallbackMs: ms2, fallbackHit: !!hit2 };
}

/* ---------- main ---------- */

async function main() {
  loadEnv();
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { console.log('No authorized device — check `adb devices`.'); process.exitCode = 1; return; }
  if (!TARGET) TARGET = devs[0];
  log(`Connected to ${TARGET}  ·  probe only, never taps Like/Send/Skip`);
  const { w, h } = screenSize();
  log(`Screen ${w}x${h}`);

  const s1 = await step1();

  // Bail loudly rather than timing the notification shade / launcher.
  {
    const xml = await getUI();
    const pkg = /package="([^"]+)"/.exec(xml);
    if (!pkg || pkg[1] !== 'co.hinge.app') {
      throw new Error(`foreground is ${pkg ? pkg[1] : 'unknown'}, not co.hinge.app — put the phone on a Discover profile first`);
    }
    if (!findDesc(xml, /^(Like |Skip )/).length && !atProfileTop(xml)) {
      throw new Error('Hinge is up but no Like/Skip controls — not on a Discover card');
    }
  }
  const s2 = await step2();
  const s3 = await step3(s2.xml);
  const s4 = await step4(s3.map);

  console.log('\n=== summary ===');
  console.log(`getUI stdout:   ${secs(s1.stdoutMs)}  ${s1.stdoutOk ? 'ok' : 'fail'}`);
  console.log(`getUI dump+cat: ${secs(s1.catMs)}  ${s1.catOk ? 'ok' : 'fail'}`);
  console.log(`scrollToTop:    ${secs(s2.ms)}  atTop ${s2.atTop ? 'yes' : 'no'}`);
  console.log(`scrape:         ${secs(s3.ms)}  ${s3.map.length} cards`);
  console.log(`find hook:      ${secs(s4.ms)}  hit ${s4.hit ? 'yes' : 'no'}`);
  if (!s4.hit && s4.fallbackMs) {
    console.log(`  fallback walk: ${secs(s4.fallbackMs)}  hit ${s4.fallbackHit ? 'yes' : 'no'}`);
  }
  console.log(`dumps used:     ${dumpCount}   path: ${USE_STDOUT ? 'exec-out stdout' : 'dump+cat'}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; });
