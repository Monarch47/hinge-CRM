#!/usr/bin/env node
/*
 * hinge-liker.js — sends Priority Likes on Hinge via ADB, with human-like pacing.
 *
 * Drives the app through its accessibility labels (content-desc), NOT fixed
 * coordinates, so it survives profiles that put the like heart in different spots.
 *
 * Usage:
 *   node hinge-liker.js [count]
 *
 * Env vars:
 *   NUM_LIKES   how many likes to send            (default 5)
 *   MIN_GAP     min seconds between profiles       (default 9)
 *   MAX_GAP     max seconds between profiles       (default 22)
 *   DRY_RUN=1   locate the buttons, open ONE send sheet, back out, send nothing
 *   ADB         path to adb                         (default /opt/homebrew/bin/adb)
 *
 * Safety:
 *   - NEVER taps the Rose (limited premium currency).
 *   - Only taps "Send Like" / "Send Priority Like".
 *   - Stops (does not mash buttons) if it can't find a like control — e.g. you
 *     ran out of profiles, hit a match popup, or hit a paywall.
 */
'use strict';
const { execFileSync } = require('child_process');

const ADB     = process.env.ADB || '/opt/homebrew/bin/adb';
const NUM     = parseInt(process.argv[2] || process.env.NUM_LIKES || '5', 10);
const MIN_GAP = parseFloat(process.env.MIN_GAP || '9');
const MAX_GAP = parseFloat(process.env.MAX_GAP || '22');
const DRY_RUN = process.env.DRY_RUN === '1';
// Anti-spam cadence: pass on one profile after every RUN_MIN..RUN_MAX likes,
// i.e. skip ~every 3rd–4th profile (randomized so it isn't a rigid pattern).
const RUN_MIN = parseInt(process.env.RUN_MIN || '2', 10);
const RUN_MAX = parseInt(process.env.RUN_MAX || '3', 10);

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
const log   = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function adb(args, wantOut = false) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'ignore'],
  });
}
const tap   = (x, y) => adb(['shell', 'input', 'tap', `${Math.round(x)}`, `${Math.round(y)}`]);
const back  = () => adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
const swipe = (x1, y1, x2, y2, d = 350) =>
  adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, d].map(v => `${Math.round(v)}`)]);

// Dump the current view hierarchy (retries; UI dumps fail during animations).
async function getUI() {
  for (let i = 0; i < 4; i++) {
    try {
      adb(['shell', 'uiautomator', 'dump', '/sdcard/hinge_ui.xml']);
      const xml = adb(['shell', 'cat', '/sdcard/hinge_ui.xml'], true);
      if (xml && xml.includes('<hierarchy')) return xml;
    } catch (_) { /* retry */ }
    await delay(700);
  }
  return '';
}

// Every node that has a content-desc, with its tap center + top edge.
function nodes(xml) {
  const re = /<node\b([^>]*?)\/?>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const d = /content-desc="([^"]*)"/.exec(attrs);
    if (!d || !d[1]) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!b) continue;
    const [, x1, y1, x2, y2] = b.map(Number);
    out.push({ desc: d[1], cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, top: y1 });
  }
  return out;
}
const find = (xml, re) => nodes(xml).filter(n => re.test(n.desc));

async function main() {
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { log('No authorized device — plug in + enable USB debugging.'); process.exit(1); }

  log(`device ${devs[0]} | target ${NUM} | gap ${MIN_GAP}-${MAX_GAP}s | ${DRY_RUN ? 'DRY RUN — sends nothing' : 'LIVE'}`);

  const nextRun = () => RUN_MIN + Math.floor(Math.random() * (RUN_MAX - RUN_MIN + 1));
  let likesBeforeSkip = nextRun();               // like this many, then pass on one

  let sent = 0, passed = 0, errors = 0, guard = 0;
  while (sent < NUM && guard++ < NUM * 4 + 20) {
    let xml = await getUI();

    // Locate a like heart; scroll the profile a little if none is on screen yet.
    let likes = find(xml, /^Like (photo|prompt)$/);
    for (let t = 0; !likes.length && t < 2; t++) {
      log('  no like control visible — scrolling');
      swipe(540, 1650, 540, 850, 400);
      await delay(rand(900, 1500));
      xml = await getUI();
      likes = find(xml, /^Like (photo|prompt)$/);
    }
    if (!likes.length) {
      log('Stopping: no like control (out of profiles, a match popup, or a paywall). Nothing further sent.');
      break;
    }

    // Anti-spam cadence: pass on this profile instead of liking it.
    if (likesBeforeSkip <= 0) {
      const sk = find(xml, /^Skip /)[0];
      if (sk) { log(`↷ passing (${sk.desc}) — anti-spam cadence`); tap(sk.cx, sk.cy); passed++; }
      else    { log('  skip button not found — leaving profile untouched'); }
      likesBeforeSkip = nextRun();
      await delay(rand(MIN_GAP, MAX_GAP) * 1000);
      continue;
    }

    likes.sort((a, b) => a.top - b.top);        // topmost heart
    const target = likes[0];
    log(`#${sent + 1}: "${target.desc}"`);
    tap(target.cx, target.cy);
    await delay(rand(1400, 2600));               // wait for the send sheet

    // Find the send button — prefer plain "Send Like", else Priority. NEVER a Rose.
    const sheet = await getUI();
    const send = find(sheet, /^Send Like$/)[0] || find(sheet, /^Send priority like$/i)[0];
    if (!send) {
      log('  send sheet not found — backing out, nothing sent');
      back(); await delay(rand(600, 1000)); back();
      errors++;
      await delay(rand(MIN_GAP, MAX_GAP) * 1000);
      continue;
    }

    if (DRY_RUN) {
      log(`  [dry-run] found "${send.desc}" @ ${Math.round(send.cx)},${Math.round(send.cy)} — backing out, NOTHING sent`);
      back(); await delay(rand(700, 1100)); back();
      log('  dry-run self-test OK (located like + send, sent nothing, passed on no one).');
      break;                                     // single-shot self-test
    }

    tap(send.cx, send.cy);
    sent++;
    likesBeforeSkip--;
    log(`  ✓ priority like sent (${sent}/${NUM})`);

    const gap = rand(MIN_GAP, MAX_GAP);
    log(`  …${gap.toFixed(1)}s`);
    await delay(gap * 1000);
  }

  log(`Done. sent=${sent} passed=${passed} errors=${errors}${DRY_RUN ? ' (dry run)' : ''}`);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
