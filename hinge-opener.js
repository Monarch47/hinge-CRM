#!/usr/bin/env node
/*
 * hinge-opener.js — auto-send loop: like a profile's top card WITH a random
 * pickup line, send a Priority Like, move on. Randomly passes on some profiles
 * so the cadence isn't robotic.
 *
 * Same philosophy as hinge-liker.js: drive the app by accessibility label
 * (content-desc), never fixed coordinates.
 *
 * Loop per profile:
 *   - roughly every 1st-4th profile (random), PASS on it (Skip) instead of liking
 *   - otherwise: tap the top like heart -> send sheet -> type a random line ->
 *     tap "Send priority like with message"   (NEVER the Rose)
 *
 * Usage:
 *   node hinge-opener.js                   # no cap, 1–5s gap, like everyone
 *   node hinge-opener.js [count]           # stop after `count` likes
 *   DRY_RUN=1 node hinge-opener.js         # like + open ONE sheet + type, back out, send nothing
 *   SERIAL=192.168.29.4:5555 node hinge-opener.js   # target a specific (e.g. wireless) device
 *
 * Env vars:
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
 *
 * On start: wakes the screen and launches co.hinge.app (no-op if already foreground).
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find adb without a hardcoded path: $ADB wins, then $PATH, then known spots.
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
  return 'adb';                 // last resort — spawn fails with a readable name
}
const ADB     = process.env.ADB || findAdb();
let   TARGET  = process.env.SERIAL || '';         // resolved to a real device in main()
// No cap by default — runs until Hinge runs out of profiles/likes. Pass a count
// (CLI arg or NUM_LIKES) to cap it.
const NUM     = (process.argv[2] || process.env.NUM_LIKES)
  ? parseInt(process.argv[2] || process.env.NUM_LIKES, 10) : Infinity;
const MIN_GAP = parseFloat(process.env.MIN_GAP || '1');
const MAX_GAP = parseFloat(process.env.MAX_GAP || '5');
const SKIP_MIN = parseInt(process.env.SKIP_MIN || '6', 10);
const SKIP_MAX = parseInt(process.env.SKIP_MAX || '0', 10);  // 0 = like everyone
const DRY_RUN = process.env.DRY_RUN === '1';
// How long to keep polling for a screen element before giving up (ms). Bump this
// on a slow phone / bad network so slow-loading sheets don't get abandoned.
const LOAD_TIMEOUT = parseInt(process.env.LOAD_TIMEOUT || '12000', 10);
// Every send sheet (their photo + the line we typed) gets screenshotted here.
const SHOTS_DIR = process.env.SHOTS_DIR || 'screenshots';

// --- the openers (a random one is used per profile) -----------------------
const LINES = [
  "Ho, manne sambh-sambh rakhe tere jhanjhara ke jode Meri gel ro-ro ye bhi chhori bawle se hore Manne aaye jaave khyaal tere, khaye jaave khyaal tere Jeen koni deti, haaye bairi tanhaayi manne Geetaan mein gaayi, kade chhaati ke lagaayi manne Jit bhi gaya",
  "re, teri yaad khadi paayi manne Sambh-sambh rakhi bahut, chhaati ke lagaayi manne Jit bhi gaya re, teri yaad khadi paayi manne Ho, maarya-maarya phire, dekh haal tu bichare ka Tere bina jeena bhi ke jeena banjaare ka? Khoya rahun yaad teri kar ke",
  "nadaaniyaan Batue mein rakhun teri sambh ke nishaaniyaan Tere bina kaal horeya, theek konya haal mera Haath jodun Ram, dede saanson te rihaayi manne Geetaan mein gaayi, kade chhaati ke lagaayi manne Jit bhi gaya re, teri yaad khadi paayi manne Sambh-sambh",
  "rakhi bahut, chhaati ke lagaayi manne Jit bhi gaya re, teri yaad khadi paayi manne Haan-aan, aan-aan Haan-aan Je tu thodi ghabraajya, meri yaad tanne aa jya Tu de diye awaaz re, main aa jaaunga Todun duniya ki reet re, ke haar re, ke jeet? Manne chahiye",
  "teri preet, main nibha jaaunga Dekh, bawla banaagi, manne likhna sikhaagi Haaye, noch-noch khaagi teri bairan judaai manne Geetaan mein gaayi, kade chhaati ke lagaayi manne Jit bhi gaya re, teri yaad khadi paayi manne Aaj tai nibhaun jo si kasam thi",
  "I'm so sure you are in a happy secure relationship but idk how to prove it - khaayi manne Zindagi saari ya meri tere lekhe laayi manne",
  "So I'm actually from the future where we have been married for 20 years. I came back to settle an argument over when and where our first date was.",
  "I lost my watch at a party once. An hour later saw some guy stepping on it while he was harassing some woman at that party. Infuriated, I immediately went over, punched him and broke his nose. No one does that to a woman, not on my watch",
  // "Oohhh, r u calling me unnecessarily sensitive?",
  // "You're so confident in your work, regardless of the results",
  // "My favourite things are eating my family and not using commas 🤭",
  // // generic / absurd
  // "Okay but what's your excuse for being this suspiciously attractive?",
  // "You seem like someone I'd accidentally end up having a 4 hour conversation with at 2am",
  // "You look like you'd ruin my sleep schedule and somehow make it seem reasonable",
  // "I don't usually believe in signs but this feels like a very poorly disguised one",
  // "You seem fun. That's concerning.",
  // "You have the exact energy of someone who says 'trust me' right before things get interesting",
  // "Okay, I have a theory about you. Unfortunately I need more evidence.",
  // "You seem like a decision I'd make without consulting anyone.",
  // "I feel like you have at least one completely unnecessary talent.",
  // "You look like you have stories that start with 'don't judge me'.",
  // "I have a feeling you're significantly more chaotic than your profile is admitting.",
  // "I have no evidence whatsoever, but I already don't trust you.",
  // // ragebait / bait-and-banter -----------------------------------------------
  // "Tum Hinge pe bhi aa gayi? Bachne ki jagah nahi hai kya?",
  // "Aren't you done looking at guys that you even came on Hinge?",
  // "Tumhe yahan kisne aane diya?",
  // "Aapka yahan kya kaam hai?",
  // "Tum bhi single ho? Damn, market kharab hai.",
  // "Accha tum bhi yahan mil gayi",
  // "Tumhare parents ko pata hai tum yahan ho?",
  // "Hinge pe bhi attendance lagani zaroori hai kya?",
  // "I have a complaint about your profile.",
  // "Tumhari profile mein ek major problem hai. Guess.",
  // "Main tumhe like karne wala tha but phir maine tumhara profile dekha.",
  // "Sach batao, ye profile tumne khud banayi hai?",
  // "Tum itni confident kyun ho ki main tumhe like karunga?",
  // "Okay, I sent you a like. Ab tum explain karo ye decision.",
  // "Tumse ek serious sawaal hai. Please disappoint me.",
  // "Rate yourself honestly: kitna headache ho?",
  // "Oye, ek baat batao — tum naturally itni questionable ho ya practice ki hai?",
  // "Mujhe lag raha hai tumhare saath normal conversation possible hi nahi hai.",
  // "Aapko dekh ke lag raha hai HR ko involve karna padega.",
  // "I already have a problem with you and we haven't even talked yet.",
  // "I have a feeling you're going to make me regret this. Hi.",
  // "I was hoping to find someone normal. Then you showed up.",
  // "You look like you'd argue with me just to see if you can win.",
  // // Hinglish
  // "Oye, itni casually interesting kaise ho?",
  // "Aapke profile mein thoda zyada hi potential dikh raha hai, suspicious hai",
  // "Bhai ye toh galat ho gaya, mujhe genuinely interesting profile mil gayi",
  // "Itna confidence allowed hai kya ya mujhe complaint file karni padegi?",
  // "Aapka vibe thoda 'main innocent hoon' bolke sabse zyada chaos karne wala hai",
  // "Sach sach batao, ye personality naturally hai ya profile ke liye rehearse kiya hai?",
  // "Tum interesting lag rahi ho, ab dekhte hain reality profile ke description se match karti hai ya nahi",
  // "Oho, ye toh unexpectedly promising lag raha hai 👀",
  // "Tumhari profile dekh ke laga 'haan isse baat karni chahiye'. Ab pressure tum pe hai.",
  // "Main normally itna jaldi invested nahi hota, but tumne inconveniently interesting cheez likh di",
  // "Thoda sambhal ke, main easily influence ho jaata hoon",
  // "Tumhare profile mein red flag dhoondhne aaya tha, abhi tak sirf excuses mil rahe hain",
  // "Aapke baare mein ek theory hai. Abhi batayi toh aap deny kar dogi.",
  // "Itni achhi profile bana ke expectations kyun badha rahi ho?",
  // "Tumhara vibe dekh ke lag raha hai 'bas ek drink' is probably a dangerous sentence",
  // "Acha suno, ek important sawaal hai. Tum actually itni funny ho ya sirf profile pe?",
  // "Tumse baat karne ka mann kar raha hai, which is mildly inconvenient",
  // "Tumhari profile mein kuch toh gadbad hai. Mujhe investigate karna padega.",
  // "Ohooo, confidence toh dekho. Respectfully, dangerous.",
  // "Mujhe lag raha hai tum normal dikhne ka bas natak kar rahi ho.",
  // "Accha, toh tumhari profile itni casually dangerous kyun hai?",
  // "Ek minute, tum actually interesting ho ya Hinge ka algorithm mujhe manipulate kar raha hai?",
  // "Tumhari profile dekh ke ek hi sawaal aaya — kitna chaos hai andar?",
  // "Oye, tumhari profile suspiciously achhi hai. Kuch toh scam hai.",
  // "Main bas profile dekh raha tha, phir laga chalo ek unnecessary decision aur le lete hain.",
  // "Accha batao, tum real life mein bhi itni problematic ho ya ye sirf marketing hai?",
  // "Tumhari profile ne mujhe ek theory di hai. Ab prove karna padega ki main galat hoon.",
  // "Aapko dekh ke lag raha hai conversation boring hone wali toh bilkul nahi hai.",
  // "Sach batao, Hinge pe aayi ho ya kisi ko jealous karne",
  // // playful / cocky
  // "You're giving 'I'll explain later' energy and I don't trust it",
  // "I'm willing to hear your defence before making any accusations",
  // "This feels like the beginning of a very questionable decision",
  // // intentionally dumb
  // "Very important: are you funny naturally or do you just have good friends?",
  // "I have absolutely no reason to ask this, but what's your most defendable red flag?",
  // "You seem like someone I'd flirt with and then accidentally become friends with. We should avoid that.",
];

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const log   = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function adb(args, wantOut = false, timeoutMs = 0) {
  const full = TARGET ? ['-s', TARGET, ...args] : args;
  try {
    return execFileSync(ADB, full, {
      encoding: 'utf8',
      stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'pipe'],
      timeout: timeoutMs || undefined,     // kill hung calls (uiautomator dump hangs when screen is off)
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    const err = String(e.stderr || '').trim().split('\n').filter(Boolean).slice(0, 2).join(' — ');
    if (err) e.message = `${e.message}\n${err}`;
    throw e;
  }
}
// Wake the screen if it dozed off during a gap (no-op if already awake).
const wake = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {} };
const PKG = 'co.hinge.app';
// Bring Hinge to the foreground (cold start or resume). Dismisses an insecure
// keyguard when we can; a PIN/pattern lock still needs a human swipe.
function launchHinge() {
  wake();
  try { adb(['shell', 'wm', 'dismiss-keyguard']); } catch (_) {}
  try {
    adb(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
  } catch (e) {
    throw new Error(`could not launch Hinge (${PKG}): ${e.message.split('\n')[0]}`);
  }
}
// Put the screen to sleep (locks the phone if a lock screen is set). SLEEP is a
// no-op when already asleep — POWER would toggle it back on.
const sleepScreen = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']); } catch (_) {} };
const tap = (x, y) => adb(['shell', 'input', 'tap', `${Math.round(x)}`, `${Math.round(y)}`]);
const back = () => adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
const swipe = (x1, y1, x2, y2, d = 400) =>
  adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, d].map(v => `${Math.round(v)}`)]);

// Filesystem-safe timestamp, e.g. 2026-08-13_05-21-04
const stamp = () => new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);

// Grab a PNG of the current screen straight to a file (binary-safe — can't use
// the utf8 adb() helper for image bytes).
function screenshot(name) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const args = TARGET ? ['-s', TARGET, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
    const png = execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024 });
    const file = path.join(SHOTS_DIR, name);
    fs.writeFileSync(file, png);
    return file;
  } catch (e) { log('  ! screenshot failed:', e.message); return null; }
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/u;
// Lyrics copy-paste often sneaks in Cyrillic/Greek lookalikes. Android's
// `input text` maps chars through KeyCharacterMap; unmappable ones return
// null and this phone NPEs: "Attempt to get length of null array".
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
  // Separate args (no device-shell quoting). Spaces → %s, literal % → %%.
  const CHUNK = 90;
  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK).replace(/%/g, '%%').replace(/ /g, '%s');
    adb(['shell', 'input', 'text', piece]);
  }
}
// `input text` is ASCII-only; ADBKeyboard can emit Unicode/emoji if installed.
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

// --- view-hierarchy helpers (same shape as hinge-liker.js) ----------------
async function getUI() {
  for (let i = 0; i < 4; i++) {
    try {
      adb(['shell', 'uiautomator', 'dump', '/sdcard/hinge_ui.xml'], false, 8000);
      const xml = adb(['shell', 'cat', '/sdcard/hinge_ui.xml'], true, 5000);
      if (xml && xml.includes('<hierarchy')) return xml;
    } catch (_) { /* dumps fail mid-animation — retry */ }
    await delay(700);
  }
  return '';
}
function nodes(xml) {
  const re = /<node\b([^>]*?)\/?>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const d = /content-desc="([^"]*)"/.exec(m[1]);
    if (!d || !d[1]) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[1]);
    if (!b) continue;
    const [, x1, y1, x2, y2] = b.map(Number);
    out.push({ desc: d[1], cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, top: y1 });
  }
  return out;
}
const find = (xml, re) => nodes(xml).filter(n => re.test(n.desc));

// Name lives on a11y labels: "Skip Jasmine", "Jasmine's photo" — never "Like photo".
function profileName(xml) {
  const skip = find(xml, /^Skip /)[0];
  if (skip) {
    const n = skip.desc.replace(/^Skip\s+/i, '').trim();
    if (n) return n;
  }
  for (const node of find(xml, /photo$/i)) {
    const n = node.desc
      .replace(/[’'`]s\s+photo$/i, '')
      .replace(/\s+photo$/i, '')
      .trim();
    if (n && !/^(like|unlike|skip)$/i.test(n)) return n;
  }
  return '';
}
function shotSlug(name) {
  return String(name || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'profile';
}

// Poll the UI until >=1 node matches `re` — rides out app lag / slow network
// instead of guessing a fixed wait. Returns { nodes, xml } or null on timeout.
async function waitFor(re, timeout = LOAD_TIMEOUT) {
  const deadline = Date.now() + timeout;
  do {
    const xml = await getUI();
    const hits = find(xml, re);
    if (hits.length) return { nodes: hits, xml };
    await delay(600);
  } while (Date.now() < deadline);
  return null;
}

// Type a random line into the open send sheet and (unless dry-run) send it.
// Returns true if a priority like was sent.
async function commentAndSend(n, whoHint, kind) {
  // Wait for the send sheet (photo + comment field) — as long as it takes.
  const boxHit = await waitFor(/^(Edit comment|Add a comment)$/);
  const who = (boxHit && profileName(boxHit.xml)) || whoHint || 'someone';
  const what = kind || 'photo';
  if (!boxHit) { log(`#${n}  ${who}  ·  ${what}  —  no comment field, backed out`); back(); await delay(700); back(); return false; }
  const box = boxHit.nodes[0];

  const line = pick(LINES);
  log(`#${n}  ${who}  ·  ${what}`);
  log(`    ${line}`);
  tap(box.cx, box.cy);
  await delay(rand(500, 900));
  try {
    typeText(line);
  } catch (e) {
    log(`    type failed — ${e.message.split('\n')[0]}`);
    back(); await delay(700); back(); return false;
  }
  await delay(rand(700, 1200));

  screenshot(`${stamp()}_${shotSlug(who)}.png`);

  // Wait for the send button to reflect the typed comment.
  const sendHit = await waitFor(/^Send (priority )?like( with message)?$/i);
  const send = sendHit && sendHit.nodes.filter(n => !/rose/i.test(n.desc))[0];
  if (!send) { log('    send button missing — backed out'); back(); await delay(700); back(); return false; }

  if (DRY_RUN) {
    log('    dry-run — typed, not sent');
    back(); await delay(700); back();
    return false;
  }
  tap(send.cx, send.cy);
  return true;
}

async function main() {
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { log('No authorized device — check `adb devices`.'); process.exit(1); }
  if (!TARGET) TARGET = devs[0];                  // avoid "more than one device" when USB+wifi both attached

  const cap = NUM === Infinity ? 'until profiles run out' : `${NUM} like${NUM === 1 ? '' : 's'} then stop`;
  const pass = SKIP_MAX <= 0 ? 'liking everyone' : `pass 1 after every ${SKIP_MIN}–${SKIP_MAX} likes`;
  log(`Connected to ${TARGET}`);
  log(`${cap} · ${MIN_GAP}–${MAX_GAP}s between likes · ${pass}${DRY_RUN ? ' · dry-run (sends nothing)' : ''}`);

  log('Opening Hinge');
  launchHinge();
  await delay(1500);                               // splash / resume settle; loop waits for like controls

  // SKIP_MAX=0 → never pass; otherwise like SKIP_MIN..SKIP_MAX profiles, then pass one.
  const nextRun = () => SKIP_MAX <= 0 ? Infinity
    : SKIP_MIN + Math.floor(Math.random() * (SKIP_MAX - SKIP_MIN + 1));
  let likesBeforeSkip = nextRun();
  let sent = 0, passed = 0, errors = 0, consecErr = 0;

  while (sent < NUM) {
    wake();                                        // undo any screen doze from the gap
    // Wait for the profile's like controls (rides out slow-loading cards).
    let hit = await waitFor(/^Like (photo|prompt)$/);
    for (let t = 0; !hit && t < 2; t++) {          // nudge the card up if none found
      log('No like button yet — scrolling');
      swipe(540, 1650, 540, 850, 400);
      hit = await waitFor(/^Like (photo|prompt)$/, 4000);
    }
    if (!hit) { log('Stopped — no like button (out of profiles, a popup, or paywall).'); break; }
    const xml = hit.xml;
    let likes = hit.nodes;
    const whoHint = profileName(xml);

    // Anti-spam: pass on this profile instead of liking it.
    if (likesBeforeSkip <= 0) {
      const sk = find(xml, /^Skip /)[0];
      if (sk) { log(`skip  ${whoHint || sk.desc.replace(/^Skip\s+/i, '') || 'someone'}`); tap(sk.cx, sk.cy); passed++; }
      else    { log(`skip  ${whoHint || 'someone'}  —  skip button missing`); }
      likesBeforeSkip = nextRun();
      await delay(rand(MIN_GAP, MAX_GAP) * 1000);
      continue;
    }

    likes.sort((a, b) => a.top - b.top);           // topmost card
    const kind = /prompt/i.test(likes[0].desc) ? 'prompt' : 'photo';
    tap(likes[0].cx, likes[0].cy);
    await delay(rand(700, 1200));                     // small settle; commentAndSend waits for the sheet

    const ok = await commentAndSend(sent + 1, whoHint, kind);
    if (ok) { sent++; likesBeforeSkip--; consecErr = 0; }
    else if (DRY_RUN) { break; }
    else {
      errors++; consecErr++;
      if (consecErr >= 5) { log('Stopped — 5 failures in a row (paywall / stuck UI / out of likes).'); break; }
    }

    await delay(rand(MIN_GAP, MAX_GAP) * 1000);
  }

  const bits = [`${sent} sent`];
  if (passed) bits.push(`${passed} skipped`);
  if (errors) bits.push(`${errors} failed`);
  log(`Done — ${bits.join(', ')}${DRY_RUN ? ' (dry-run)' : ''}`);
}
main()
  .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })   // no process.exit — let the lock below run
  .finally(() => {
    if (process.env.NO_LOCK === '1') return;
    log('Locking screen');
    sleepScreen();
  });
