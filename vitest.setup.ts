/**
 * Global vitest setup – runs once before every test file.
 * Provides a lightweight in-memory localStorage when the environment
 * does not ship a native implementation (e.g. jsdom without full Storage).
 */
const entries = new Map<string, string>();

const storage: Storage = {
  get length() {
    return entries.size;
  },
  clear() {
    entries.clear();
  },
  getItem(key: string) {
    return entries.has(key) ? entries.get(key) ?? null : null;
  },
  key(index: number) {
    return Array.from(entries.keys())[index] ?? null;
  },
  removeItem(key: string) {
    entries.delete(key);
  },
  setItem(key: string, value: string) {
    entries.set(key, String(value));
  },
};

if (typeof window !== "undefined") {
  // Only replace localStorage when it is missing or incomplete.
  const existing = window.localStorage as Partial<Storage> | undefined;
  if (
    !existing ||
    typeof existing.getItem !== "function" ||
    typeof existing.setItem !== "function" ||
    typeof existing.removeItem !== "function" ||
    typeof existing.clear !== "function"
  ) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
      writable: true,
    });
  }
}
