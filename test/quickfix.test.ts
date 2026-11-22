import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/lib/graph';
import { applyQuickFixes, toIsoDate, toIsoDuration, stripCurrency, inferCurrency, toAbsoluteUrl } from '../src/lib/quickfix';
import type { Block, Issue } from '../src/lib/types';

const CTX = 'https://schema.org';
const PAGE = 'https://ex.com/products/widget';

/** Builds the graph for one JSON-LD block per object. */
function build(objs: object | object[], pageUrl = PAGE): { graph: ReturnType<typeof buildGraph>; blocks: Block[] } {
  const blocks: Block[] = (Array.isArray(objs) ? objs : [objs]).map((data, index) => ({
    source: 'json-ld',
    index,
    data: { '@context': CTX, ...data },
  }));
  return { graph: buildGraph({ url: pageUrl, title: '', blocks }), blocks };
}

/** Apply quick-fixes, rebuild the graph from the fixed blocks, and return the new issues. */
function fixedIssues(objs: object | object[], pageUrl = PAGE): { fixes: number; issues: Issue[] } {
  const { graph, blocks } = build(objs, pageUrl);
  const { fixes, fixedBlocks } = applyQuickFixes(graph, blocks, pageUrl);
  const rebuilt = buildGraph({ url: pageUrl, title: '', blocks: fixedBlocks });
  return { fixes: fixes.length, issues: rebuilt.issues };
}

const has = (issues: Issue[], re: RegExp) => issues.some((i) => re.test(i.message));

/* ---------------- pure helpers ---------------- */

test('toIsoDate parses free-form dates', () => {
  assert.equal(toIsoDate('May 3 2024'), '2024-05-03');
  assert.equal(toIsoDate('2024-05-03'), undefined); // already ISO
  assert.equal(toIsoDate('not a date'), undefined);
});

test('toIsoDuration parses free-form durations', () => {
  assert.equal(toIsoDuration('90 min'), 'PT1H30M');
  assert.equal(toIsoDuration('2 hours 15 minutes'), 'PT2H15M');
  assert.equal(toIsoDuration('45 seconds'), 'PT45S');
  assert.equal(toIsoDuration('1 day'), 'P1D');
  assert.equal(toIsoDuration('PT30M'), undefined); // already ISO
  assert.equal(toIsoDuration('lots'), undefined);
});

test('stripCurrency removes symbols and separators', () => {
  assert.equal(stripCurrency('$1,299'), '1299');
  assert.equal(stripCurrency('€19.99'), '19.99');
  assert.equal(stripCurrency('1299'), '1299');
  assert.equal(stripCurrency('free'), undefined);
});

test('inferCurrency maps symbols to ISO codes', () => {
  assert.equal(inferCurrency('$5'), 'USD');
  assert.equal(inferCurrency('€5'), 'EUR');
  assert.equal(inferCurrency('£5'), 'GBP');
  assert.equal(inferCurrency('5'), undefined);
});

test('toAbsoluteUrl resolves relative paths', () => {
  assert.equal(toAbsoluteUrl('/img/a.png', PAGE), 'https://ex.com/img/a.png');
  assert.equal(toAbsoluteUrl('https://cdn.ex.com/a.png', PAGE), undefined);
  assert.equal(toAbsoluteUrl('#frag', PAGE), undefined);
});

/* ---------------- end-to-end: fixes clear the issues ---------------- */

test('date fix clears the ISO 8601 warning', () => {
  const before = build({ '@type': 'Event', name: 'Meetup', startDate: 'May 3 2024', location: 'Library' }).graph.issues;
  assert.ok(has(before, /startDate is not ISO 8601/));
  const { fixes, issues } = fixedIssues({ '@type': 'Event', name: 'Meetup', startDate: 'May 3 2024', location: 'Library' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /startDate is not ISO 8601/), issues.map((i) => i.message).join('\n'));
});

test('duration fix clears the ISO 8601 duration warning', () => {
  const { fixes, issues } = fixedIssues({ '@type': 'Recipe', name: 'Cake', totalTime: '90 min' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /totalTime should be an ISO 8601 duration/), issues.map((i) => i.message).join('\n'));
});

test('price strip-currency clears the plain-number warning', () => {
  const { fixes, issues } = fixedIssues({ '@type': 'Offer', price: '$1,299', priceCurrency: 'USD' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /price should be a plain number/), issues.map((i) => i.message).join('\n'));
});

test('add-priceCurrency infers currency from the price symbol', () => {
  const before = build({ '@type': 'Offer', price: '$5' }).graph.issues;
  assert.ok(has(before, /Offer is missing "priceCurrency"/));
  const { fixes, issues } = fixedIssues({ '@type': 'Offer', price: '$5' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /missing "priceCurrency"/), issues.map((i) => i.message).join('\n'));
});

test('priceCurrency normalization uppercases a lowercase code', () => {
  const { fixes, issues } = fixedIssues({ '@type': 'Offer', price: '5', priceCurrency: 'usd' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /priceCurrency should be an ISO 4217 code/), issues.map((i) => i.message).join('\n'));
});

test('absolute-url fix clears the relative-URL warning', () => {
  const { fixes, issues } = fixedIssues({ '@type': 'Product', name: 'W', image: '/img/w.png' });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /image is not an absolute URL/), issues.map((i) => i.message).join('\n'));
});

test('enum typo fix corrects InStok to InStock', () => {
  const before = build({ '@type': 'Product', name: 'W', offers: { '@type': 'Offer', price: '5', priceCurrency: 'USD', availability: 'InStok' } }).graph.issues;
  assert.ok(has(before, /not a valid ItemAvailability/));
  const { fixes, issues } = fixedIssues({ '@type': 'Product', name: 'W', offers: { '@type': 'Offer', price: '5', priceCurrency: 'USD', availability: 'InStok' } });
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /not a valid ItemAvailability/), issues.map((i) => i.message).join('\n'));
});

test('misspelled property rename clears the unknown-property warning', () => {
  // 'nane' is a single-deletion typo of 'name' (edit distance 1), so suggest() maps it.
  const before = build({ '@type': 'Product', 'nane': 'Widget' }).graph.issues;
  assert.ok(has(before, /Product is missing "name"/), before.map((i) => i.message).join('\n'));
  const { fixes, issues } = fixedIssues({ '@type': 'Product', 'nane': 'Widget' });
  assert.ok(fixes >= 1, 'expected a rename fix');
  assert.ok(!has(issues, /Product is missing "name"/), issues.map((i) => i.message).join('\n'));
});

test('island @id link fix connects disconnected graphs', () => {
  const objs = [
    { '@type': 'WebSite', '@id': 'https://ex.com/#site', name: 'Ex', url: 'https://ex.com/' },
    { '@type': 'WebPage', '@id': 'https://ex.com/#page', name: 'P' },
  ];
  const before = build(objs).graph.issues;
  assert.ok(has(before, /isn't linked to WebSite/));
  const { fixes, issues } = fixedIssues(objs);
  assert.ok(fixes >= 1);
  assert.ok(!has(issues, /isn't linked to WebSite/), issues.map((i) => i.message).join('\n'));
});

test('fixes never mutate the original blocks', () => {
  const { graph, blocks } = build({ '@type': 'Offer', price: '$5' });
  const snapshot = JSON.stringify(blocks);
  applyQuickFixes(graph, blocks, PAGE);
  assert.equal(JSON.stringify(blocks), snapshot, 'original blocks must be untouched');
});

test('a clean page yields zero fixes', () => {
  const { graph, blocks } = build({ '@type': 'Product', name: 'W', url: 'https://ex.com/w' });
  const { fixes } = applyQuickFixes(graph, blocks, PAGE);
  assert.equal(fixes.length, 0);
});