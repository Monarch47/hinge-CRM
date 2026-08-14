#!/usr/bin/env node
/*
 * check-package.js — refuse to ship a bad tarball.
 *
 * This repo keeps a .env with a live OpenAI key, run journals under logs/,
 * screenshots of real people and a hinge-log.html full of their names and
 * messages, all a few characters away from being published forever. The
 * `files` allowlist in package.json is what keeps them out; this asserts the
 * allowlist actually did its job, so a careless edit fails CI instead of
 * leaking.
 *
 *   node scripts/check-package.js
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const problems = [];
const note = m => console.log(`  ${m}`);

// Nothing matching these may ever be inside the tarball.
const FORBIDDEN = [
  /(^|\/)\.env$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)logs\//,
  /(^|\/)screenshots(_cropped)?\//,
  /(^|\/)persona\.md$/,
  /(^|\/)\.cursor\//,
  /(^|\/)\.DS_Store$/,
  /\.(png|jpe?g)$/i,
];
// Secret-shaped strings, in any shipped file.
const SECRETS = [
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style key'],
  [/npm_[A-Za-z0-9]{30,}/, 'npm token'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/OPENAI_API_KEY\s*=\s*\S+/, 'populated OPENAI_API_KEY'],
];
// Read at runtime — if these go missing the CLI breaks after install.
const REQUIRED = ['hinge.js', 'hinge-read.js', 'hinge-liker.js', 'hinge-opener.js', 'opener-prompt.md', 'hinge-log.html'];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Pack for real: --dry-run can diverge from what actually gets uploaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgcheck-'));
const out = execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tarball = path.join(tmp, out.trim().split('\n').pop().trim());
execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
const dir = path.join(tmp, 'package');

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [path.relative(dir, p)];
});
const files = walk(dir).sort();

console.log(`\n${pkg.name}@${pkg.version} — ${files.length} files`);
for (const f of files) note(f);

console.log('\nchecks');
for (const f of files) {
  for (const re of FORBIDDEN) {
    if (re.test(f)) problems.push(`forbidden file in tarball: ${f}`);
  }
}
note(problems.length ? 'forbidden files: FAIL' : 'forbidden files: none');

let secretHits = 0;
for (const f of files) {
  let body;
  try { body = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
  for (const [re, what] of SECRETS) {
    const m = re.exec(body);
    // .env.example ships an empty OPENAI_API_KEY= and must stay allowed.
    if (m && !(f === '.env.example' && /OPENAI_API_KEY/.test(m[0]) && /=\s*$/.test(m[0]))) {
      problems.push(`${what} found in ${f}`);
      secretHits++;
    }
  }
}
note(secretHits ? 'secret scan: FAIL' : 'secret scan: clean');

const missing = REQUIRED.filter(f => !files.includes(f));
if (missing.length) problems.push(`missing runtime file(s): ${missing.join(', ')}`);
note(missing.length ? `required files: MISSING ${missing.join(', ')}` : 'required files: all present');

// The shipped log must be the empty viewer template, never a real one.
const logPath = path.join(dir, 'hinge-log.html');
if (fs.existsSync(logPath)) {
  const rows = (fs.readFileSync(logPath, 'utf8').match(/"status":"sent"/g) || []).length;
  if (rows) problems.push(`hinge-log.html ships ${rows} real profile row(s)`);
  note(rows ? `log template: FAIL (${rows} rows)` : 'log template: empty');
}

for (const [name, rel] of Object.entries(pkg.bin || {})) {
  const p = path.join(dir, rel);
  if (!fs.existsSync(p)) { problems.push(`bin "${name}" -> ${rel} not in tarball`); continue; }
  if (!fs.readFileSync(p, 'utf8').startsWith('#!')) problems.push(`bin "${name}" (${rel}) has no shebang`);
}
note('bin entries: checked');

for (const f of files.filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { problems.push(`syntax error in ${f}: ${String(e.stderr).split('\n')[0]}`); }
}
note('syntax: checked');

fs.rmSync(tmp, { recursive: true, force: true });

if (problems.length) {
  console.error('\nFAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nOK — safe to publish\n');
