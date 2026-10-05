import fs from 'fs';
import os from 'os';
import path from 'path';
import { VideoStore } from '../media-worker/videoStore';

describe('VideoStore (Reels feed videos)', () => {
  let root: string;
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const file = (name: string, bytes: number) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibi-videos-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a downloaded video under the import id', () => {
    const store = new VideoStore(path.join(root, 'videos'), {} as any, { maxBytes: 1_000_000, retentionMs: 60_000 });
    const kept = store.keep('src_123_abcd', file('media.mp4', 100));
    expect(kept).toBeDefined();
    expect(store.find('src_123_abcd')).toBe(kept);
    expect(store.status('src_123_abcd').state).toBe('ready');
    expect(VideoStore.contentType(kept!)).toBe('video/mp4');
  });

  it('drops the least recently used videos past the size cap', () => {
    const store = new VideoStore(path.join(root, 'videos'), {} as any, { maxBytes: 250, retentionMs: 60_000 });
    const old = store.keep('src_old_1111', file('a.mp4', 100))!;
    fs.utimesSync(old, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    store.keep('src_mid_2222', file('b.mp4', 100));
    store.keep('src_new_3333', file('c.mp4', 100));
    store.prune();
    expect(store.find('src_old_1111')).toBeUndefined();
    expect(store.find('src_new_3333')).toBeDefined();
  });

  it('downloads a video once and reports failures', async () => {
    let downloads = 0;
    const ytdlp = {
      downloadVideo: async (url: string, dir: string) => {
        downloads++;
        if (url.includes('broken')) throw new Error('nope');
        const out = path.join(dir, 'media.mp4');
        fs.writeFileSync(out, Buffer.alloc(10, 1));
        return out;
      }
    } as any;
    const store = new VideoStore(path.join(root, 'videos'), ytdlp, { maxBytes: 1_000_000, retentionMs: 60_000 });

    expect(store.prepare('src_ok_1234', 'https://vt.tiktok.com/ok/').state).toBe('preparing');
    expect(store.prepare('src_ok_1234', 'https://vt.tiktok.com/ok/').state).toBe('preparing');
    await waitFor(() => store.status('src_ok_1234').state === 'ready');
    expect(store.status('src_ok_1234').state).toBe('ready');
    expect(store.prepare('src_ok_1234', 'https://vt.tiktok.com/ok/').state).toBe('ready');

    store.prepare('src_bad_1234', 'https://vt.tiktok.com/broken/');
    await waitFor(() => store.status('src_bad_1234').state === 'failed');
    expect(store.status('src_bad_1234').state).toBe('failed');
    // A failure isn't retried on its own, only when asked.
    expect(store.prepare('src_bad_1234', 'https://vt.tiktok.com/broken/').state).toBe('failed');
    expect(downloads).toBe(2);
  });
});
