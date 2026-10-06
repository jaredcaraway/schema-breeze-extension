import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bump, classify, isNewer, notes, suggestBump } from '../scripts/semver.ts';

const merge = (pr: number, branch: string, title: string) =>
  classify(`Merge pull request #${pr} from jaredcaraway/${branch}`, `${title}\n`);

test('PR merges are classified by branch prefix', () => {
  assert.deepEqual(merge(4, 'feat/schema-islands', 'Flag disconnected graphs'), {
    type: 'feat', breaking: false, title: 'Flag disconnected graphs', pr: 4,
  });
  assert.equal(merge(7, 'fix/graph-overlap', 'Keep nodes apart').type, 'fix');
  assert.equal(merge(8, 'chore/rename', 'Rename').type, 'chore');
  assert.equal(merge(9, 'feat!/new-storage', 'Move settings').breaking, true);
});

test('direct commits use a conventional prefix when present', () => {
  assert.deepEqual(classify('feat(graph): add rings layout', ''), { type: 'feat', breaking: false, title: 'add rings layout' });
  assert.equal(classify('fix!: drop Firefox 109', '').breaking, true);
  assert.equal(classify('Rename the extension', '').type, 'other');
  assert.equal(classify('Rework storage', 'BREAKING CHANGE: settings reset').breaking, true);
});

test('suggestBump picks the largest change', () => {
  const fix = classify('fix: x', ''), feat = classify('feat: y', ''), brk = classify('feat!: z', '');
  assert.equal(suggestBump([fix, feat], true, '1.2.3'), 'minor');
  assert.equal(suggestBump([fix, brk], true, '1.2.3'), 'major');
  assert.equal(suggestBump([fix], true, '1.2.3'), 'patch');
  assert.equal(suggestBump([classify('docs: readme', '')], true, '1.2.3'), 'patch', 'shipped files changed');
});

test('nothing to release when no shipped files changed and no features', () => {
  assert.equal(suggestBump([classify('docs: readme', '')], false, '1.2.3'), null);
  assert.equal(suggestBump([], false, '1.2.3'), null);
});

test('a breaking change below 1.0.0 bumps minor', () => {
  assert.equal(suggestBump([classify('feat!: z', '')], true, '0.4.1'), 'minor');
});

test('bump and isNewer', () => {
  assert.equal(bump('0.2.0', 'patch'), '0.2.1');
  assert.equal(bump('0.2.3', 'minor'), '0.3.0');
  assert.equal(bump('0.2.3', 'major'), '1.0.0');
  assert.ok(isNewer('0.10.0', '0.9.9'));
  assert.ok(!isNewer('0.2.0', '0.2.0'));
  assert.throws(() => bump('1.2', 'patch'));
});

test('notes group changes and cite PRs', () => {
  const text = notes([merge(4, 'feat/islands', 'Flag islands'), merge(7, 'fix/overlap', 'Keep nodes apart'), classify('Tidy', '')]);
  assert.equal(text, 'Features\n- Flag islands (#4)\n\nFixes\n- Keep nodes apart (#7)\n\nOther\n- Tidy');
});
