// Cuts a release from main: suggests the next semver version from the commits
// since the last tag, then asks before each step (bump, test, build, commit,
// tag, push, GitHub release, Chrome Web Store, AMO).
//
//   npm run release            interactive release
//   npm run release:check      only show what would be released
//   npm run release -- --stores    redo the store uploads for the release on HEAD
//
// Store credentials are read from the environment or from .env.release
// (see .env.release.example). A store without credentials is skipped.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { bump, classify, isNewer, notes, parse, SHIPPED_PATHS, suggestBump, type Bump, type Change } from './semver.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');
const QUIET = process.argv.includes('--quiet');
const STORES = process.argv.includes('--stores');

// Nothing to nudge about during a release's own build, or in a source checkout
// without git (e.g. AMO reviewers building the source zip).
if (QUIET && (process.env.SCHEMA_BREEZE_RELEASING || !existsSync(`${ROOT}.git`))) process.exit(0);
if (existsSync(`${ROOT}.env.release`)) process.loadEnvFile(`${ROOT}.env.release`);

const current = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).version as string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args: string[]) => {
  try { return git(...args); } catch { return null; }
};

function run(cmd: string, args: string[]): boolean {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // Commands don't read stdin, so they can't swallow answers meant for the prompts.
  const env = { ...process.env, SCHEMA_BREEZE_RELEASING: '1' };
  return spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env }).status === 0;
}

const fail = (msg: string): never => {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
};

// Answers are queued as they arrive, so typed-ahead or piped answers aren't lost while a step runs.
// The reader starts on the first question, so --check and --quiet don't hold stdin open.
let rl: ReturnType<typeof createInterface> | undefined;
const lines: string[] = [];
const waiting: ((l: string) => void)[] = [];
const question = (q: string): Promise<string> => {
  if (!rl) {
    rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
    rl.on('close', () => waiting.splice(0).forEach((w) => w('q')));
  }
  process.stdout.write(q);
  return lines.length ? Promise.resolve(lines.shift()!) : new Promise((r) => waiting.push(r));
};
const ask = async (q: string, yesDefault = true) => {
  const a = (await question(`${q} ${yesDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (a === 'q') return false;
  return a ? a.startsWith('y') : yesDefault;
};

/** Uploads to each store that has credentials, asking first. Returns what wasn't done. */
async function publishToStores(): Promise<string[]> {
  const skipped: string[] = [];
  const chromeVars = ['EXTENSION_ID', 'PUBLISHER_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'].filter((v) => !process.env[v]);
  const chromeStep = 'Chrome Web Store upload';
  if (chromeVars.length) {
    console.log(`\nChrome Web Store: skipped, missing ${chromeVars.join(', ')}.`);
    skipped.push(chromeStep);
  } else if (await ask('Upload to the Chrome Web Store and submit for review?')) {
    if (!run('npx', ['chrome-webstore-upload', '--source', 'schema-breeze-chrome.zip'])) skipped.push(chromeStep);
  } else skipped.push(chromeStep);

  const amoVars = ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET'].filter((v) => !process.env[v]);
  const amoArgs = ['web-ext', 'sign', '--channel=listed', '--source-dir', 'dist/firefox', '--upload-source-code', 'schema-breeze-source.zip'];
  const amoStep = 'Firefox Add-ons submission';
  if (amoVars.length) {
    console.log(`\nFirefox Add-ons: skipped, missing ${amoVars.join(', ')}.`);
    skipped.push(amoStep);
  } else if (await ask('Submit to Firefox Add-ons (AMO) for review?')) {
    if (!run('npx', amoArgs)) skipped.push(amoStep);
  } else skipped.push(amoStep);
  return skipped;
}

if (STORES) {
  const tag = `v${current}`;
  if (tryGit('describe', '--exact-match', '--tags', 'HEAD') !== tag) fail(`HEAD isn't tagged ${tag}. Check out the release first.`);
  run('npm', ['run', 'build']) || fail('build failed.');
  run('git', ['archive', '--format=zip', '-o', 'schema-breeze-source.zip', tag]) || fail('git archive failed.');
  const skipped = await publishToStores();
  rl?.close();
  if (skipped.length) console.log(`\nNot done:\n${skipped.map((s) => `  ${s}`).join('\n')}`);
  process.exit(0);
}

// ---- What changed since the last release ----

const lastTag = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'main');
const range = lastTag ? `${lastTag}..main` : 'main';

const changes: Change[] = git('log', '--first-parent', '--format=%s%x1f%b%x1e', range)
  .split('\x1e')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [subject, body = ''] = r.split('\x1f');
    return classify(subject, body);
  })
  .filter((c) => !/^Release v\d/.test(c.title));

const shippedChanged = !lastTag || git('diff', '--name-only', range, '--', ...SHIPPED_PATHS) !== '';
// The first tagged release ships the version already in package.json.
const suggested: Bump | 'current' | null = lastTag ? suggestBump(changes, shippedChanged, current) : 'current';
const proposed = suggested === 'current' ? current : suggested ? bump(current, suggested) : null;

if (QUIET) {
  // Used after `npm run build`: a one-line nudge, nothing when there's nothing to release.
  if (proposed) console.log(`\n${lastTag ? `Unreleased changes on main since ${lastTag}.` : 'Nothing has been released yet.'} Suggested release: v${proposed}. Run \`npm run release\` to cut it.`);
  process.exit(0);
}

console.log(`Last release: ${lastTag ?? 'none (untagged)'} · package.json: ${current}`);
console.log(changes.length ? `\nChanges on main since then:\n${notes(changes).replace(/^(?=.)/gm, '  ')}` : '\nNo changes on main since then.');
if (!proposed) {
  console.log('\nNothing shipped has changed, so no release is needed.');
  process.exit(0);
}
const breaking = changes.some((c) => c.breaking) ? ', includes breaking changes' : '';
const why = suggested === 'current' ? 'first tagged release' : `${suggested} bump${breaking}`;
console.log(`\nSuggested version: v${proposed} (${why})`);
if (CHECK) process.exit(0);

// ---- Preflight ----

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to main first (git switch main).');
if (git('status', '--porcelain', '--untracked-files=no')) fail('commit or stash your changes first.');
run('git', ['fetch', 'origin', 'main', '--tags', '--quiet']) || fail('git fetch failed.');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main differs from origin/main. Pull or push first.');

let version = proposed;
for (;;) {
  const a = (await question(`\nRelease v${version}? Enter to accept, or type patch / minor / major / x.y.z / q: `)).trim().toLowerCase();
  if (!a) break;
  if (a === 'q') process.exit(0);
  if (a === 'patch' || a === 'minor' || a === 'major') { version = bump(current, a); continue; }
  try { parse(a.replace(/^v/, '')); version = a.replace(/^v/, ''); } catch { console.log('Not a version.'); }
}
const tag = `v${version}`;
if (tryGit('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) fail(`${tag} already exists.`);
if (lastTag && !isNewer(version, lastTag.slice(1))) fail(`${tag} isn't newer than ${lastTag}; the stores reject that.`);

// ---- Bump, test, build, commit, tag ----

if (version !== current) run('npm', ['version', version, '--no-git-tag-version']) || fail('npm version failed.');
run('npm', ['test']) || fail('tests failed. Nothing was committed; `git checkout package.json package-lock.json` to undo the bump.');
run('npm', ['run', 'build']) || fail('build failed. Nothing was committed.');

const releaseNotes = notes(changes) || 'First tagged release.';
if (version !== current) run('git', ['commit', '-m', `Release ${tag}`, '--', 'package.json', 'package-lock.json']) || fail('commit failed.');
run('git', ['tag', '-a', tag, '-m', `${tag}\n\n${releaseNotes}`]) || fail('tag failed.');
// AMO asks for readable source when the submitted code is bundled.
run('git', ['archive', '--format=zip', '-o', 'schema-breeze-source.zip', tag]) || fail('git archive failed.');
console.log(`\nTagged ${tag}. Packages: schema-breeze-chrome.zip, schema-breeze-firefox.zip, schema-breeze-source.zip`);

// ---- Publish: each step asks first and can be redone by hand ----

const skipped: string[] = [];

if (await ask(`\nPush main and ${tag} to origin?`)) {
  if (!run('git', ['push', 'origin', 'main', tag])) skipped.push(`git push origin main ${tag}`);
} else skipped.push(`git push origin main ${tag}`);

const ghArgs = ['release', 'create', tag, 'schema-breeze-chrome.zip', 'schema-breeze-firefox.zip', '--title', tag, '--notes', releaseNotes];
if (await ask('Create a GitHub release with both zips attached?')) {
  if (!run('gh', ghArgs)) skipped.push(`gh release create ${tag} schema-breeze-chrome.zip schema-breeze-firefox.zip --title ${tag} --notes-from-tag`);
} else skipped.push(`gh release create ${tag} schema-breeze-chrome.zip schema-breeze-firefox.zip --title ${tag} --notes-from-tag`);

if ((await publishToStores()).length) skipped.push('npm run release -- --stores');

rl?.close();
console.log(`\nReleased ${tag}.`);
if (skipped.length) console.log(`Not done; run these when ready:\n${skipped.map((s) => `  ${s}`).join('\n')}`);
