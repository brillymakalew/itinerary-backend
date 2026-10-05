// Videos kept for the app's Reels feed: the file an import downloaded (or one prepared on request)
// is served to the phones, so a video plays the moment it's scrolled to, like TikTok.

import fs from 'fs';
import path from 'path';
import { TaskQueue } from './taskQueue';
import { YtDlp, YtDlpError } from './ytDlp';

/** 'unsupported': the platform can't be downloaded here (YouTube refuses the server). */
export type VideoState = 'ready' | 'preparing' | 'failed' | 'missing' | 'unsupported';

export interface VideoStatus {
  state: VideoState;
  error?: string;
}

export interface VideoStoreOptions {
  maxBytes: number;
  retentionMs: number;
  /** Largest single video accepted. */
  maxVideoBytes?: number;
}

const CONTENT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const PRUNE_EVERY_WRITES = 10;

export class VideoStore {
  private failures = new Map<string, string>();
  private preparing = new Set<string>();
  /** One download at a time: preparing reels never competes with imports being analyzed. */
  private downloads = new TaskQueue<{ sourceId: string }>(1);
  private writes = 0;

  constructor(
    private readonly dir: string,
    private readonly ytdlp: YtDlp,
    private readonly options: VideoStoreOptions
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.prune();
  }

  static safeId(sourceId: string): string {
    return sourceId.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  static contentType(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'video/mp4';
  }

  /** The stored file for [sourceId], if any (marks it recently used). */
  find(sourceId: string): string | undefined {
    const base = VideoStore.safeId(sourceId);
    const name = fs.readdirSync(this.dir).find(f => path.parse(f).name === base && !f.endsWith('.part'));
    if (!name) return undefined;
    const file = path.join(this.dir, name);
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      // Removed meanwhile.
    }
    return file;
  }

  /** Moves (or copies) a downloaded video into the store for [sourceId]. */
  keep(sourceId: string, filePath: string): string | undefined {
    try {
      const size = fs.statSync(filePath).size;
      if (size === 0 || size > (this.options.maxVideoBytes ?? Number.MAX_SAFE_INTEGER)) return undefined;
      const ext = (path.extname(filePath) || '.mp4').toLowerCase();
      const previous = this.find(sourceId);
      if (previous) fs.rmSync(previous, { force: true });
      const target = path.join(this.dir, `${VideoStore.safeId(sourceId)}${ext}`);
      try {
        fs.renameSync(filePath, target);
      } catch {
        fs.copyFileSync(filePath, target);
      }
      this.failures.delete(sourceId);
      if (++this.writes % PRUNE_EVERY_WRITES === 0) this.prune();
      return target;
    } catch (err: any) {
      console.warn(`[Videos] Could not keep the video for ${sourceId}:`, err?.message ?? err);
      return undefined;
    }
  }

  status(sourceId: string): VideoStatus {
    if (this.find(sourceId)) return { state: 'ready' };
    if (this.preparing.has(sourceId)) return { state: 'preparing' };
    const failure = this.failures.get(sourceId);
    return failure ? { state: 'failed', error: failure } : { state: 'missing' };
  }

  /**
   * Downloads [url] for [sourceId] unless it's stored, being downloaded, or already failed (a
   * failed one is tried again when [retryFailed] is set).
   */
  prepare(sourceId: string, url: string, retryFailed = false): VideoStatus {
    if (this.find(sourceId)) return { state: 'ready' };
    if (this.preparing.has(sourceId)) return { state: 'preparing' };
    if (this.failures.has(sourceId) && !retryFailed) return { state: 'failed', error: this.failures.get(sourceId) };
    this.failures.delete(sourceId);
    this.preparing.add(sourceId);
    this.downloads.enqueue({ sourceId }, async () => {
      let work: string | undefined;
      try {
        work = fs.mkdtempSync(path.join(this.dir, '.dl-'));
        const file = await this.ytdlp.downloadVideo(url, work, this.options.maxVideoBytes ?? 150 * 1024 * 1024);
        if (!this.keep(sourceId, file)) this.failures.set(sourceId, 'The video couldn’t be stored.');
      } catch (err) {
        const reason = err instanceof YtDlpError ? err.message : 'The video couldn’t be downloaded.';
        console.warn(`[Videos] ${sourceId}: ${reason}`);
        this.failures.set(sourceId, reason);
      } finally {
        this.preparing.delete(sourceId);
        if (work) fs.rmSync(work, { recursive: true, force: true });
      }
    });
    return { state: 'preparing' };
  }

  /** Drops videos past their retention, then the least recently watched while over the size cap. */
  prune() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(this.dir)
        .filter(name => !name.startsWith('.'))
        .map(name => {
          const file = path.join(this.dir, name);
          const stat = fs.statSync(file);
          return { file, size: stat.size, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      let total = 0;
      for (const entry of files) {
        total += entry.size;
        if (now - entry.mtimeMs > this.options.retentionMs || total > this.options.maxBytes) fs.rmSync(entry.file, { force: true });
      }
      // Leftovers of interrupted downloads.
      for (const name of fs.readdirSync(this.dir).filter(n => n.startsWith('.dl-'))) {
        const file = path.join(this.dir, name);
        if (now - fs.statSync(file).mtimeMs > 60 * 60 * 1000) fs.rmSync(file, { recursive: true, force: true });
      }
    } catch (err: any) {
      console.warn('[Videos] Could not prune stored videos:', err?.message ?? err);
    }
  }
}
