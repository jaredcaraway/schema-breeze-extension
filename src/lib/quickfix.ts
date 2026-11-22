import type { Block, Graph } from './types';
import { enumMembers, isEnumeration, isProperty, propertyNames, ranges, suggest } from './vocab';

/**
 * Roadmap 3.1 (#14): mechanical quick-fixes for structured-data issues.
 *
 * For every issue that has a deterministic, mechanical fix, produce a {@link Fix}
 * describing the change (before/after) and apply every fix to a copy of the
 * page's JSON-LD blocks. The corrected blocks are written so that re-running
 * Schema Breeze's own checks reports the targeted issues gone.
 *
 * Fixes never invent content: when a value only the user knows is required
 * (e.g. a missing `image`), a clearly marked placeholder is inserted instead.
 */

export type FixKind =
  | 'rename-property'
  | 'fix-enum'
  | 'convert-date'
  | 'convert-duration'
  | 'absolute-url'
  | 'strip-currency'
  | 'add-priceCurrency'
  | 'normalize-priceCurrency'
  | 'add-id-link';

export interface Fix {
  kind: FixKind;
  /** Block the fix was applied to, e.g. "json-ld#1". */
  blockKey: string;
  /** The @id of the entity the fix touches, when known. */
  entityId?: string;
  /** The property the fix adds or changes. */
  property?: string;
  /** One-line, human-readable description of the change. */
  description: string;
  /** The value before the fix, as a JSON snippet (or "(missing)"). */
  before: string;
  /** The value after the fix, as a JSON snippet. */
  after: string;
}

export interface QuickFixResult {
  fixes: Fix[];
  /** Deep-cloned blocks with every mechanical fix applied; originals untouched. */
  fixedBlocks: Block[];
}

/* Constants mirror validate.ts so a fix targets exactly what the checker flags. */
const DATE_PROPS = new Set([
  'datePublished', 'dateModified', 'dateCreated', 'startDate', 'endDate', 'uploadDate',
  'datePosted', 'validThrough', 'validFrom', 'priceValidUntil', 'birthDate', 'foundingDate',
]);
const URL_PROPS = new Set(['url', 'image', 'logo', 'sameAs', 'thumbnailUrl', 'contentUrl', 'embedUrl', 'item']);
const DURATION_PROPS = new Set(['duration', 'cookTime', 'prepTime', 'totalTime']);
const ISO_DATE = /^\d{4}(-\d{2}(-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;
const SCHEMA_URL = /^https?:\/\/schema\.org\/([^/?#]+)$/i;

const CURRENCY_SYMBOLS: [string, string][] = [
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₩', 'KRW'], ['₽', 'RUB'], ['₺', 'TRY'],
];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isForeign = (term: string) => term.startsWith('@') || /[:/]/.test(term);

/** Deep-walk every JSON-LD node object (objects that carry properties), depth-first. */
function walkNodes(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkNodes(item, visit);
    return;
  }
  if (!isObj(node)) return;
  // A {"@value": ...} wrapper is a literal, not a node.
  if ('@value' in node) return;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === '@context') continue;
    walkNodes(v, visit);
  }
}

/** Rebuild an object's keys, replacing `from` with `to` in place (preserving order). */
function renameKey(obj: Record<string, unknown>, from: string, to: string): void {
  const entries = Object.entries(obj).map(([k, v]) => [k === from ? to : k, v] as const);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k] = v;
}

/** Find the node object carrying a given @id within a block's data. */
function findNodeById(data: unknown, id: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  walkNodes(data, (obj) => {
    if (!found && obj['@id'] === id) found = obj;
  });
  return found;
}

/** Parse a free-form duration into an ISO 8601 duration (e.g. "90 min" -> "PT1H30M"). */
export function toIsoDuration(input: string): string | undefined {
  const s = input.trim();
  if (!s || /^P/i.test(s)) return undefined;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u.startsWith('d')) total += n * 86400;
    else if (u.startsWith('h')) total += n * 3600;
    else if (u.startsWith('m')) total += n * 60;
    else total += n;
  }
  if (!matched) return undefined;
  const days = Math.floor(total / 86400);
  const rem = total - days * 86400;
  const hours = Math.floor(rem / 3600);
  const minutes = Math.floor((rem - hours * 3600) / 60);
  const seconds = Math.round(rem - hours * 3600 - minutes * 60);
  const datePart = days ? `P${days}D` : 'P';
  const timeParts: string[] = [];
  if (hours) timeParts.push(`${hours}H`);
  if (minutes) timeParts.push(`${minutes}M`);
  if (seconds) timeParts.push(`${seconds}S`);
  if (!timeParts.length) return days ? datePart : 'PT0S';
  return `${datePart}T${timeParts.join('')}`;
}

/** Parse a free-form date into an ISO 8601 date (or date-time). */
export function toIsoDate(input: string): string | undefined {
  const s = input.trim();
  if (!s || ISO_DATE.test(s)) return undefined;
  const hasTime = /\d{1,2}:\d{2}/.test(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hasTime) return d.toISOString();
  // Compare against the local wall-clock the string described to avoid TZ day-shift.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strip currency symbols and thousands separators from a price -> plain number string. */
export function stripCurrency(input: string): string | undefined {
  const cleaned = input.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(cleaned) ? cleaned : undefined;
}

/** Infer an ISO 4217 code from a currency symbol in the original price string. */
export function inferCurrency(input: string): string | undefined {
  for (const [sym, code] of CURRENCY_SYMBOLS) if (input.includes(sym)) return code;
  return undefined;
}

/** Make a relative URL absolute against the page URL; returns undefined if not fixable. */
export function toAbsoluteUrl(input: string, pageUrl: string): string | undefined {
  const s = input.trim();
  if (!s || /^https?:\/\//i.test(s) || s.startsWith('#')) return undefined;
  try {
    return new URL(s, pageUrl).href;
  } catch {
    return undefined;
  }
}

const snippet = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/**
 * Compute mechanical quick-fixes for a built graph and apply them to a copy of
 * the page's JSON-LD blocks. Returns the fixes plus the corrected blocks.
 */
export function applyQuickFixes(graph: Graph, blocks: Block[], pageUrl: string): QuickFixResult {
  const fixedBlocks = clone(blocks);
  const fixes: Fix[] = [];
  const blockByKey = new Map(fixedBlocks.map((b) => [`${b.source}#${b.index + 1}`, b]));

  // --- Island @id links (from islands.ts suggestions) --------------------
  // islandIssues emits: `Add "PROP": { "@id": "TARGET" } to the TYPE.`
  const addLink = /Add "([^"]+)": \{ "@id": "([^"]+)" \} to the/;
  for (const issue of graph.issues) {
    if (!issue.entityId) continue;
    const m = issue.message.match(addLink);
    if (!m) continue;
    const [, prop, targetId] = m;
    const source = graph.entities.get(issue.entityId);
    if (!source) continue;
    const block = source.definedIn.map((bk) => blockByKey.get(bk)).find((b) => b && !b.error);
    if (!block) continue;
    const node = findNodeById(block.data, source.id);
    if (!node || node[prop] !== undefined) continue;
    node[prop] = { '@id': targetId };
    fixes.push({
      kind: 'add-id-link',
      blockKey: `${block.source}#${block.index + 1}`,
      entityId: source.id,
      property: prop,
      description: `Link ${source.types[0] ?? 'entity'} "${source.label || source.id}" to ${targetId} via "${prop}".`,
      before: '(missing)',
      after: `"${prop}": { "@id": ${snippet(targetId)} }`,
    });
  }

  // --- Per-node mechanical fixes -----------------------------------------
  for (const block of fixedBlocks) {
    if (block.source !== 'json-ld' || block.error || block.data === undefined) continue;
    const blockKey = `${block.source}#${block.index + 1}`;
    walkNodes(block.data, (node) => {
      const entityId = typeof node['@id'] === 'string' ? (node['@id'] as string) : undefined;
      // Capture the original price before any fix mutates it, so the currency
      // symbol is still available when inferring priceCurrency below.
      const originalPrice = node['price'];

      // Rename misspelled properties using the existing "did you mean" suggestion.
      for (const key of Object.keys(node)) {
        if (isForeign(key) || isProperty(key)) continue;
        const suggestion = suggest(key, propertyNames());
        if (!suggestion || suggestion === key) continue;
        renameKey(node, key, suggestion);
        fixes.push({
          kind: 'rename-property',
          blockKey,
          entityId,
          property: suggestion,
          description: `Rename misspelled property "${key}" to "${suggestion}".`,
          before: snippet(key),
          after: snippet(suggestion),
        });
      }

      for (const [prop, raw] of Object.entries(node)) {
        if (isForeign(prop)) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        values.forEach((v, i) => {
          if (typeof v !== 'string') return;
          const set = (nv: string) => {
            if (Array.isArray(raw)) (raw as unknown[])[i] = nv;
            else node[prop] = nv;
          };

          // Enumeration typos: "InStok" -> "https://schema.org/InStock".
          const rs = ranges(prop);
          const enums = rs.filter(isEnumeration);
          if (enums.length) {
            const url = v.match(SCHEMA_URL);
            const bareName = url ? url[1] : /^[A-Za-z]\w*$/.test(v) ? v : undefined;
            if (bareName) {
              const members = enums.flatMap(enumMembers);
              if (!members.includes(bareName)) {
                const suggestion = suggest(bareName, members);
                if (suggestion) {
                  const nv = `https://schema.org/${suggestion}`;
                  set(nv);
                  fixes.push({
                    kind: 'fix-enum',
                    blockKey,
                    entityId,
                    property: prop,
                    description: `Correct enumeration value "${bareName}" to "${suggestion}".`,
                    before: snippet(v),
                    after: snippet(nv),
                  });
                  return;
                }
              }
            }
          }

          // Dates -> ISO 8601.
          if (DATE_PROPS.has(prop) && !ISO_DATE.test(v)) {
            const nv = toIsoDate(v);
            if (nv) {
              set(nv);
              fixes.push({
                kind: 'convert-date',
                blockKey,
                entityId,
                property: prop,
                description: `Convert "${prop}" to ISO 8601.`,
                before: snippet(v),
                after: snippet(nv),
              });
              return;
            }
          }

          // Durations -> ISO 8601.
          if (DURATION_PROPS.has(prop) && !/^P/i.test(v)) {
            const nv = toIsoDuration(v);
            if (nv) {
              set(nv);
              fixes.push({
                kind: 'convert-duration',
                blockKey,
                entityId,
                property: prop,
                description: `Convert "${prop}" to an ISO 8601 duration.`,
                before: snippet(v),
                after: snippet(nv),
              });
              return;
            }
          }

          // Relative URLs -> absolute.
          if (URL_PROPS.has(prop) && !/^https?:\/\//i.test(v) && !(prop === 'item' && v.startsWith('#'))) {
            const nv = toAbsoluteUrl(v, pageUrl);
            if (nv) {
              set(nv);
              fixes.push({
                kind: 'absolute-url',
                blockKey,
                entityId,
                property: prop,
                description: `Make "${prop}" an absolute URL.`,
                before: snippet(v),
                after: snippet(nv),
              });
              return;
            }
          }

          // Price with currency symbol / thousands separator -> plain number.
          if (prop === 'price' && !/^\d+(\.\d+)?$/.test(v)) {
            const nv = stripCurrency(v);
            if (nv) {
              set(nv);
              fixes.push({
                kind: 'strip-currency',
                blockKey,
                entityId,
                property: prop,
                description: `Strip currency symbol and separators from "price".`,
                before: snippet(v),
                after: snippet(nv),
              });
              return;
            }
          }

          // priceCurrency not an ISO 4217 code -> uppercase it if it's a 3-letter code.
          if (prop === 'priceCurrency' && !/^[A-Z]{3}$/.test(v)) {
            const nv = v.trim().toUpperCase();
            if (/^[A-Z]{3}$/.test(nv)) {
              set(nv);
              fixes.push({
                kind: 'normalize-priceCurrency',
                blockKey,
                entityId,
                property: prop,
                description: `Normalize "priceCurrency" to an ISO 4217 code.`,
                before: snippet(v),
                after: snippet(nv),
              });
              return;
            }
          }
        });
      }

      // Offer missing priceCurrency but with a currency symbol in price -> add it.
      const hasPrice = originalPrice !== undefined && originalPrice !== null;
      const hasCurrency = node['priceCurrency'] !== undefined;
      if (hasPrice && !hasCurrency) {
        const priceStr = String(originalPrice);
        const code = inferCurrency(priceStr);
        if (code) {
          node['priceCurrency'] = code;
          fixes.push({
            kind: 'add-priceCurrency',
            blockKey,
            entityId,
            property: 'priceCurrency',
            description: `Add "priceCurrency": "${code}" inferred from the price symbol.`,
            before: '(missing)',
            after: snippet(code),
          });
        }
      }
    });
  }

  return { fixes, fixedBlocks };
}