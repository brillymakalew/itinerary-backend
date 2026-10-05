// A small key → value cache kept in a JSON file, so repeat Google lookups survive restarts and
// don't spend the free tier twice.

import fs from 'fs';
import path from 'path';

const SAVE_DELAY_MS = 5_000;

export class JsonFileCache<V> {
  private entries = new Map<string, { at: number; value: V }>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string | undefined,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {
    this.load();
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V) {
    // Re-inserting moves the key to the end, so the oldest entries are the first to go.
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.scheduleSave();
  }

  delete(key: string) {
    if (this.entries.delete(key)) this.scheduleSave();
  }

  /** Writes pending changes now. */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as [string, { at: number; value: V }][];
      const cutoff = this.now() - this.ttlMs;
      for (const [key, entry] of stored) {
        if (entry?.at >= cutoff) this.entries.set(key, entry);
      }
    } catch (err: any) {
      console.warn(`[Cache] Ignoring unreadable ${path.basename(this.filePath)}:`, err?.message ?? err);
    }
  }

  private scheduleSave() {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify([...this.entries]));
      fs.renameSync(temp, this.filePath);
    } catch (err: any) {
      console.warn(`[Cache] Could not save ${path.basename(this.filePath)}:`, err?.message ?? err);
    }
  }
}
