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
 *   node hinge-opener.js [count]           # send `count` likes (default: no cap, till out of profiles)
 *   DRY_RUN=1 node hinge-opener.js         # like + open ONE sheet + type, back out, send nothing
 *   SERIAL=192.168.29.4:5555 node hinge-opener.js   # target a specific (e.g. wireless) device
 *
 * Env vars:
 *   NUM_LIKES  how many to send            (default: no cap, or first CLI arg)
 *   MIN_GAP    min seconds between profiles (default 60 = 1 min)
 *   MAX_GAP    max seconds between profiles (default 300 = 5 min)
 *   SKIP_MIN   like this many then pass one, low end   (default 1)
 *   SKIP_MAX   ...high end                             (default 4)
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
const MIN_GAP = parseFloat(process.env.MIN_GAP || '60');    // 1 min
const MAX_GAP = parseFloat(process.env.MAX_GAP || '300');   // 5 min
const SKIP_MIN = parseInt(process.env.SKIP_MIN || '1', 10);
const SKIP_MAX = parseInt(process.env.SKIP_MAX || '4', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
// How long to keep polling for a screen element before giving up (ms). Bump this
// on a slow phone / bad network so slow-loading sheets don't get abandoned.
const LOAD_TIMEOUT = parseInt(process.env.LOAD_TIMEOUT || '12000', 10);
// Every send sheet (their photo + the line we typed) gets screenshotted here.
const SHOTS_DIR = process.env.SHOTS_DIR || 'screenshots';

// --- the openers (a random one is used per profile) -----------------------
const LINES = [
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "Rate my Hinge profile tell me what to keep, change, or remove, and why???!!!",
  "I'm so sure you are in a happy secure relationship but idk how to prove it",
  "So I'm actually from the future where we have been married for 20 years. I came back to settle an argument over when and where our first date was.",
  "I lost my watch at a party once. An hour later saw some guy stepping on it while he was harassing some woman at that party. Infuriated, I immediately went over, punched him and broke his nose. No one does that to a woman, not on my watch",
  "Oohhh, r u calling me unnecessarily sensitive?",
  "You're so confident in your work, regardless of the results",
  "My favourite things are eating my family and not using commas 🤭",
  // generic / absurd
  "Okay but what's your excuse for being this suspiciously attractive?",
  "I was gonna come up with a clever opener but then I remembered I'm naturally this charming",
  "Be honest, did you match because of my personality or are you just fascinated by my ability to overshare?",
  "You seem like someone I'd accidentally end up having a 4 hour conversation with at 2am",
  "I have a very important question: are you always this much trouble or is today special?",
  "You look like you'd ruin my sleep schedule and somehow make it seem reasonable",
  "I feel like we'd either get along incredibly well or become each other's most interesting inconvenience",
  "You seem suspiciously like my type. I'm choosing to investigate further.",
  "I don't usually believe in signs but this feels like a very poorly disguised one",
  "I had a great opener prepared but unfortunately you distracted me by existing",
  "I think Hinge has finally started making questionable decisions on my behalf",
  "Okay wait, I have questions. Several. None of them are legally important.",
  "You seem fun. That's concerning.",
  "I'm getting the feeling you're either very normal or an absolute menace. No middle ground.",
  "I can't tell if you're a green flag or just really good at marketing",
  "You have the exact energy of someone who says 'trust me' right before things get interesting",
  "I feel like I'd have to meet you twice just to figure out what's going on here",
  "Okay, I have a theory about you. Unfortunately I need more evidence.",
  "You seem like a decision I'd make without consulting anyone.",
  "I was gonna scroll past peacefully but apparently that's not happening.",
  "Okay this is either a very good idea or a very entertaining mistake.",
  "I feel like you have at least one completely unnecessary talent.",
  "You look like you have stories that start with 'don't judge me'.",
  "I have a feeling you're significantly more chaotic than your profile is admitting.",
  "I'm not saying you're trouble. I'm saying the evidence is concerning.",
  "You seem suspiciously capable of turning a normal plan into a story.",
  "I don't trust people who look this innocent. Too much potential for plot twists.",
  "Okay, before anything else, what's the weirdest thing I should know about you?",
  "You have approximately 30 seconds to convince me this match wasn't a terrible idea.",
  "I feel like there's a very specific reason you ended up on my screen today.",
  "Not to be dramatic but I feel like Hinge just handed me a side quest.",
  "I have no evidence whatsoever, but I already don't trust you.",
  "You seem like someone who'd make 'let's just go for coffee' unnecessarily complicated.",
  "I'm getting strong 'this was supposed to be a quick conversation' energy.",
  "Okay wait. You seem like trouble, but the academically interesting kind.",
  // Hinglish
  "Oye, itni casually interesting kaise ho?",
  "Aapke profile mein thoda zyada hi potential dikh raha hai, suspicious hai",
  "Bhai ye toh galat ho gaya, mujhe genuinely interesting profile mil gayi",
  "Tumse baat karke lag raha hai Hinge ne aaj finally kuch sahi kiya",
  "Accha ji, toh aap trouble ho. Noted.",
  "Itna confidence allowed hai kya ya mujhe complaint file karni padegi?",
  "Aapka vibe thoda 'main innocent hoon' bolke sabse zyada chaos karne wala hai",
  "Sach sach batao, ye personality naturally hai ya profile ke liye rehearse kiya hai?",
  "Tum interesting lag rahi ho, ab dekhte hain reality profile ke description se match karti hai ya nahi",
  "Oho, ye toh unexpectedly promising lag raha hai 👀",
  "Tumhari profile dekh ke laga 'haan isse baat karni chahiye'. Ab pressure tum pe hai.",
  "Main normally itna jaldi invested nahi hota, but tumne inconveniently interesting cheez likh di",
  "Accha toh tum woh type ho. Interesting.",
  "Thoda sambhal ke, main easily influence ho jaata hoon",
  "Tumhare profile mein red flag dhoondhne aaya tha, abhi tak sirf excuses mil rahe hain",
  "Aapke baare mein ek theory hai. Abhi batayi toh aap deny kar dogi.",
  "Mujhe lag raha hai tumhare saath normal conversation possible hi nahi hai",
  "Okay fine, tum interesting ho. Khush?",
  "Itni achhi profile bana ke expectations kyun badha rahi ho?",
  "Tumhara vibe dekh ke lag raha hai 'bas ek drink' is probably a dangerous sentence",
  "Ye match thoda zyada convenient hai. Hinge kuch toh chhupa raha hai.",
  "Acha suno, ek important sawaal hai. Tum actually itni funny ho ya sirf profile pe?",
  "Tumse baat karne ka mann kar raha hai, which is mildly inconvenient",
  "Tumhari profile mein kuch toh gadbad hai. Mujhe investigate karna padega.",
  "Ohooo, confidence toh dekho. Respectfully, dangerous.",
  "Mujhe lag raha hai tum normal dikhne ka bas natak kar rahi ho.",
  "Accha, toh tumhari profile itni casually dangerous kyun hai?",
  "Ek minute, tum actually interesting ho ya Hinge ka algorithm mujhe manipulate kar raha hai?",
  "Tumhari profile dekh ke ek hi sawaal aaya — kitna chaos hai andar?",
  "Oye, tumhari profile suspiciously achhi hai. Kuch toh scam hai.",
  "Main bas profile dekh raha tha, phir laga chalo ek unnecessary decision aur le lete hain.",
  "Tumse match hona coincidence tha ya Hinge finally meri side pe hai?",
  "Accha batao, tum real life mein bhi itni problematic ho ya ye sirf marketing hai?",
  "Tumhari profile ne mujhe ek theory di hai. Ab prove karna padega ki main galat hoon.",
  "Aapko dekh ke lag raha hai conversation boring hone wali toh bilkul nahi hai.",
  "Oye, ek baat batao — tum naturally itni questionable ho ya practice ki hai?",
  "Thoda suspicious match hai ye. Main investigation start kar raha hoon.",
  "Mujhe lag raha hai tumhare saath 'normal conversation' ek unrealistic expectation hai.",
  // playful / cocky
  "I can already tell you're going to be difficult. Fortunately, I enjoy unnecessary challenges.",
  "You seem like someone who would challenge me just for entertainment",
  "I have a feeling you're going to disagree with me a lot. Perfect.",
  "Finally, someone who looks like they can keep up",
  "You seem like a bad influence. I'm open to conducting further research.",
  "I was going to be normal about this but your profile has made that unnecessarily difficult",
  "You have approximately 3 business days to prove you're not secretly chaotic",
  "I feel like you're going to make fun of me and honestly I'm okay with that",
  "You're giving 'I'll explain later' energy and I don't trust it",
  "I don't know what your red flag is yet, but I'm sure we'll discover it together",
  "You seem like the kind of person who wins arguments by being annoyingly charming",
  "I have a feeling you'd be very difficult to impress. Conveniently, I like a challenge.",
  "You look like you'd have an unnecessarily strong opinion about something completely irrelevant",
  "I'm willing to hear your defence before making any accusations",
  "This feels like the beginning of a very questionable decision",
  // intentionally dumb
  "Important: if we get married, who gets custody of the aux?",
  "Quick compatibility test: fries are they a side or a main?",
  "Before we proceed, I need to know your stance on stealing fries",
  "I need to know whether you're the type to say 'one episode' and then watch six",
  "Hypothetically, if we got lost somewhere, are you navigating or are we both just accepting our fate?",
  "Very important: are you funny naturally or do you just have good friends?",
  "Would you rather have unlimited coffee or unlimited plane tickets? Choose carefully, this determines everything.",
  "I have absolutely no reason to ask this, but what's your most defendable red flag?",
  // slightly flirty
  "You're making a very strong case for me being right about my type",
  "I was prepared to be unimpressed and then you had to go and be interesting",
  "You have a dangerous combination of cute and suspicious",
  "I'm trying to figure out whether you're actually this charming or if I'm just easily influenced",
  "Okay, you're attractive. But I have a feeling that's the least interesting thing about you.",
  "You seem like someone I'd flirt with and then accidentally become friends with. We should avoid that.",
  "I feel like we'd have dangerously good banter",
  "You're kind of distracting. I had a point somewhere.",
  "I can't decide if I want to impress you or annoy you first",
  "You're giving me very little reason to behave normally",
];

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const log   = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function adb(args, wantOut = false, timeoutMs = 0) {
  const full = TARGET ? ['-s', TARGET, ...args] : args;
  return execFileSync(ADB, full, {
    encoding: 'utf8',
    stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'ignore'],
    timeout: timeoutMs || undefined,     // kill hung calls (uiautomator dump hangs when screen is off)
    killSignal: 'SIGKILL',
  });
}
// Wake the screen if it dozed off during a gap (no-op if already awake).
const wake = () => { try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {} };
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

// Wrap so the ON-DEVICE shell sees the whole line as one literal arg.
const devQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/u;

// `input text` can't emit emoji; use ADBKeyboard if present, else strip + warn.
function hasAdbKeyboard() {
  try { return /com\.android\.adbkeyboard/.test(adb(['shell', 'pm', 'list', 'packages', 'com.android.adbkeyboard'], true)); }
  catch (_) { return false; }
}
function typeText(text) {
  if (!EMOJI.test(text)) { adb(['shell', `input text ${devQuote(text)}`]); return; }
  if (hasAdbKeyboard()) {
    let prev = '';
    try { prev = adb(['shell', 'settings', 'get', 'secure', 'default_input_method'], true).trim(); } catch (_) {}
    adb(['shell', 'ime', 'enable', 'com.android.adbkeyboard/.AdbIME']);
    adb(['shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
    adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text, 'utf8').toString('base64')]);
    if (prev && !/adbkeyboard/.test(prev)) adb(['shell', 'ime', 'set', prev]);
    return;
  }
  const clean = text.replace(new RegExp(EMOJI, 'gu'), '').replace(/\s+/g, ' ').trim();
  log('  ! emoji line but no ADBKeyboard — sending without the emoji');
  adb(['shell', `input text ${devQuote(clean)}`]);
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
async function commentAndSend() {
  // Wait for the send sheet (photo + comment field) — as long as it takes.
  const boxHit = await waitFor(/^(Edit comment|Add a comment)$/);
  if (!boxHit) { log('  comment field never appeared (lag/paywall) — backing out.'); back(); await delay(700); back(); return false; }
  const box = boxHit.nodes[0];

  const line = pick(LINES);
  log(`  line: "${line}"`);
  tap(box.cx, box.cy);
  await delay(rand(500, 900));
  typeText(line);
  await delay(rand(700, 1200));

  // Screenshot the sheet (their photo + the line we typed) into SHOTS_DIR.
  const photoNode = find(boxHit.xml, /photo$/i)[0];
  const who = ((photoNode ? photoNode.desc.replace(/[’'`]s\s+photo$/i, '').replace(/\s+photo$/i, '').trim() : '')
    .replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)) || 'profile';
  const shot = screenshot(`${stamp()}_${who}.png`);
  if (shot) log(`  📸 saved ${shot}`);

  // Wait for the send button to reflect the typed comment.
  const sendHit = await waitFor(/^Send (priority )?like( with message)?$/i);
  const send = sendHit && sendHit.nodes.filter(n => !/rose/i.test(n.desc))[0];
  if (!send) { log('  send button not found — backing out, nothing sent.'); back(); await delay(700); back(); return false; }

  if (DRY_RUN) {
    log(`  [dry-run] would tap "${send.desc}" — backing out, NOTHING sent.`);
    back(); await delay(700); back();
    return false;
  }
  log(`  sending via "${send.desc}"`);
  tap(send.cx, send.cy);
  return true;
}

async function main() {
  const devs = adb(['devices'], true).trim().split('\n').slice(1)
    .filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  if (!devs.length) { log('No authorized device — check `adb devices`.'); process.exit(1); }
  if (!TARGET) TARGET = devs[0];                  // avoid "more than one device" when USB+wifi both attached

  log(`device ${TARGET} | target ${NUM === Infinity ? '∞ (no cap)' : NUM} | gap ${MIN_GAP}-${MAX_GAP}s | pass ~1 of every ${SKIP_MIN}-${SKIP_MAX} | ${DRY_RUN ? 'DRY RUN — sends nothing' : 'LIVE'}`);

  const nextRun = () => SKIP_MIN + Math.floor(Math.random() * (SKIP_MAX - SKIP_MIN + 1));
  let likesBeforeSkip = nextRun();
  let sent = 0, passed = 0, errors = 0, consecErr = 0;

  while (sent < NUM) {
    wake();                                        // undo any screen doze from the gap
    // Wait for the profile's like controls (rides out slow-loading cards).
    let hit = await waitFor(/^Like (photo|prompt)$/);
    for (let t = 0; !hit && t < 2; t++) {          // nudge the card up if none found
      log('  no like control yet — scrolling');
      swipe(540, 1650, 540, 850, 400);
      hit = await waitFor(/^Like (photo|prompt)$/, 4000);
    }
    if (!hit) { log('Stopping: no like control (out of profiles / popup / paywall).'); break; }
    const xml = hit.xml;
    let likes = hit.nodes;

    // Anti-spam: pass on this profile instead of liking it.
    if (likesBeforeSkip <= 0) {
      const sk = find(xml, /^Skip /)[0];
      if (sk) { log(`↷ passing (${sk.desc})`); tap(sk.cx, sk.cy); passed++; }
      else    { log('  skip button not found — leaving profile untouched'); }
      likesBeforeSkip = nextRun();
      await delay(rand(MIN_GAP, MAX_GAP) * 1000);
      continue;
    }

    likes.sort((a, b) => a.top - b.top);           // topmost card
    const heart = likes[0];
    log(`#${sent + 1}: liking "${heart.desc}"`);
    tap(heart.cx, heart.cy);
    await delay(rand(700, 1200));                     // small settle; commentAndSend waits for the sheet

    const ok = await commentAndSend();
    if (ok) { sent++; likesBeforeSkip--; consecErr = 0; log(`  ✓ priority like sent (${NUM === Infinity ? sent : `${sent}/${NUM}`})`); }
    else if (DRY_RUN) { log('  dry-run self-test OK (liked, typed, sent nothing).'); break; }
    else {
      errors++; consecErr++;
      if (consecErr >= 5) { log('Stopping: 5 failures in a row (paywall / stuck UI / out of likes).'); break; }
    }

    const gap = rand(MIN_GAP, MAX_GAP);
    log(`  …${gap.toFixed(1)}s`);
    await delay(gap * 1000);
  }

  log(`Done. sent=${sent} passed=${passed} errors=${errors}${DRY_RUN ? ' (dry run)' : ''}`);
}
main()
  .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })   // no process.exit — let the lock below run
  .finally(() => {
    if (process.env.NO_LOCK === '1') return;
    log('locking screen');
    sleepScreen();
  });
