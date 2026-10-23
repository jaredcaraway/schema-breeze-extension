import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFollow, resolveTab, writeFollow } from '../src/lib/pin.ts';

test('the first load pins the sidebar to the active tab', () => {
  assert.deepEqual(resolveTab(7, undefined, false), { pinned: 7, read: 7 });
});

test('a pinned sidebar reads only its own tab', () => {
  assert.deepEqual(resolveTab(7, 7, false), { pinned: 7, read: 7 });
  assert.deepEqual(resolveTab(9, 7, false), { pinned: 7, read: undefined });
});

test('following re-pins to whichever tab is active', () => {
  assert.deepEqual(resolveTab(9, 7, true), { pinned: 9, read: 9 });
});

test('no active tab reads nothing and keeps the pin', () => {
  assert.deepEqual(resolveTab(undefined, 7, false), { pinned: 7, read: undefined });
  assert.deepEqual(resolveTab(undefined, undefined, true), { pinned: undefined, read: undefined });
});

test('the follow setting defaults to off and survives a round trip', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(readFollow(store), false);
  writeFollow(true, store);
  assert.equal(readFollow(store), true);
  writeFollow(false, store);
  assert.equal(readFollow(store), false);
});

test('storage that throws reads as off', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readFollow(broken), false);
  assert.doesNotThrow(() => writeFollow(true, broken));
});
