// Decides the next release version from the commits on main since the last tag.
// PR merges are classified by their branch prefix (feat/, fix/, chore/…), other
// commits by a conventional-commit prefix if they have one.

export type Bump = 'major' | 'minor' | 'patch';

export interface Change {
  /** feat, fix, chore… or 'other' when the commit gives no hint. */
  type: string;
  breaking: boolean;
  /** PR title for merges, the subject otherwise. */
  title: string;
  pr?: number;
}

/** Files that end up in the packaged extension. Changes elsewhere (tests, docs, tooling) don't need a release. */
export const SHIPPED_PATHS = ['src', 'public', 'manifest', 'vocab', 'sidebar.html', 'vite.config.ts', 'scripts/manifest.ts', 'scripts/build-vocab.ts', 'package-lock.json'];

const MERGE = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)/;

export function classify(subject: string, body: string): Change {
  const breakingBody = /^BREAKING[ -]CHANGE/m.test(body);
  const merge = MERGE.exec(subject);
  if (merge) {
    const branch = merge[2];
    const slash = branch.indexOf('/');
    const prefix = slash > 0 ? branch.slice(0, slash) : 'other';
    const type = prefix.replace(/!$/, '');
    return {
      type,
      breaking: prefix.endsWith('!') || breakingBody,
      title: body.split('\n')[0].trim() || branch,
      pr: Number(merge[1]),
    };
  }
  const conv = CONVENTIONAL.exec(subject);
  if (conv) return { type: conv[1].toLowerCase(), breaking: !!conv[2] || breakingBody, title: conv[3] };
  return { type: 'other', breaking: breakingBody, title: subject };
}

/**
 * The bump the changes call for, or null when nothing shipped changed.
 * Below 1.0.0 a breaking change bumps the minor version (semver treats 0.x as unstable);
 * going to 1.0.0 is a deliberate choice made at the prompt.
 */
export function suggestBump(changes: Change[], shippedChanged: boolean, current: string): Bump | null {
  const preOne = current.startsWith('0.');
  if (changes.some((c) => c.breaking)) return preOne ? 'minor' : 'major';
  if (changes.some((c) => c.type === 'feat')) return 'minor';
  return shippedChanged ? 'patch' : null;
}

export function bump(version: string, kind: Bump): string {
  const [major, minor, patch] = parse(version);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function parse(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a semver version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(a: string, b: string): boolean {
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

const HEADINGS: [string, string][] = [['feat', 'Features'], ['fix', 'Fixes']];

/** Release notes grouped into Features, Fixes and Other. */
export function notes(changes: Change[]): string {
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const heading = HEADINGS.find(([t]) => t === c.type)?.[1] ?? 'Other';
    groups.set(heading, [...(groups.get(heading) ?? []), c]);
  }
  return ['Features', 'Fixes', 'Other']
    .filter((h) => groups.has(h))
    .map((h) => `${h}\n${groups.get(h)!.map((c) => `- ${c.breaking ? '[breaking] ' : ''}${c.title}${c.pr ? ` (#${c.pr})` : ''}`).join('\n')}`)
    .join('\n\n');
}
