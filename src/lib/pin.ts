/** Which tab the sidebar reads. It stays on the tab it was opened on unless "Follow the active tab" is on. */

const FOLLOW_KEY = 'schema-breeze:follow-active-tab';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** `read` is the tab to scan, or undefined when the active tab isn't the one the sidebar is pinned to. */
export function resolveTab(
  active: number | undefined,
  pinned: number | undefined,
  follow: boolean,
): { pinned: number | undefined; read: number | undefined } {
  if (active === undefined) return { pinned, read: undefined };
  if (follow || pinned === undefined) return { pinned: active, read: active };
  return { pinned, read: active === pinned ? active : undefined };
}

export function readFollow(store: Store = localStorage): boolean {
  try {
    return store.getItem(FOLLOW_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeFollow(on: boolean, store: Store = localStorage): void {
  try {
    store.setItem(FOLLOW_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the setting lasts until the sidebar closes.
  }
}
