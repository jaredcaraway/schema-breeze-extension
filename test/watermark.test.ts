import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeLayout, finishExport, stampedLayout } from '../src/lib/watermark.ts';

test('the badge sits in the bottom-right corner, inside the image', () => {
  const b = badgeLayout(2000, 1200, 200);
  assert.equal(b.x + b.width + b.margin, 2000);
  assert.equal(b.y + b.height + b.margin, 1200);
  assert.ok(b.x > 0 && b.y > 0);
});

test('the badge scales with the image but stays small', () => {
  assert.equal(badgeLayout(600, 400, 100).height, 48, 'floor for small exports');
  assert.equal(badgeLayout(8000, 5000, 100).height, 72, 'ceiling for huge exports');
  const mid = badgeLayout(1600, 1200, 100).height;
  assert.ok(mid > 48 && mid < 72);
});

test('the badge is wide enough for the icon, the gap and the measured text', () => {
  const b = badgeLayout(2000, 1200, 300);
  assert.equal(b.width, b.padX + b.icon + b.gap + 300 + b.padX);
  assert.ok(b.textX >= b.x + b.padX + b.icon);
});

test('the badge goes in a strip added below the image, so it never covers the graph', () => {
  const { canvasW, canvasH, badge } = stampedLayout(2000, 1200, 200);
  assert.equal(canvasW, 2000);
  assert.ok(badge.y >= 1200, 'badge starts below the original image');
  assert.equal(canvasH, badge.y + badge.height + badge.margin);
  assert.equal(badge.y - 1200, badge.margin, 'same gap above and below the badge');
});

test('free exports are watermarked, paid ones are not', async () => {
  const png = new Blob(['png']);
  const stamped = new Blob(['stamped']);
  const stamp = async () => stamped;
  const opts = { dark: true, background: '#111723', stamp };
  assert.equal(await finishExport(png, { ...opts, paid: false }), stamped);
  assert.equal(await finishExport(png, { ...opts, paid: true }), png);
});
