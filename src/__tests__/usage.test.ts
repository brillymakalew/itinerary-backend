import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  audioCostUsd,
  levelFor,
  monthKey,
  nextMonthStart,
  tokenCostUsd,
  UsageLimitError,
  UsageMeter
} from '../usage/usageMeter';
import { JsonFileCache } from '../places/fileCache';
import { TaskQueue } from '../media-worker/taskQueue';

describe('free-tier levels', () => {
  it('warns at half, nearly used up at 80% and pauses at 90%', () => {
    expect(levelFor(49.9)).toBe('ok');
    expect(levelFor(50)).toBe('half');
    expect(levelFor(80)).toBe('almost');
    expect(levelFor(89.9)).toBe('almost');
    expect(levelFor(90)).toBe('paused');
  });

  it('counts Google by Pacific-time month and OpenAI by UTC month', () => {
    const halloweenNightPacific = new Date('2026-11-01T05:00:00Z');
    expect(monthKey(halloweenNightPacific, 'UTC')).toBe('2026-11');
    expect(monthKey(halloweenNightPacific, 'America/Los_Angeles')).toBe('2026-10');
    expect(nextMonthStart('2026-12')).toBe('2027-01-01');
  });

  it('prices tokens and audio, erring high for unknown models', () => {
    expect(tokenCostUsd('gpt-4o-mini-2024-07-18', 1_000_000, 1_000_000)).toBeCloseTo(0.75);
    expect(tokenCostUsd('some-new-model', 1_000_000, 0)).toBeCloseTo(2.5);
    expect(audioCostUsd('whisper-1', 600)).toBeCloseTo(0.06);
  });
});

describe('UsageMeter', () => {
  let now = new Date('2026-10-15T12:00:00Z');
  const clock = () => now;

  it('stops OpenAI calls at 90% of the monthly budget and starts again next month', () => {
    now = new Date('2026-10-15T12:00:00Z');
    const meter = new UsageMeter({ openAiBudgetUsd: 1, now: clock });
    // 1M input tokens of gpt-4o-mini = $0.15 each.
    for (let i = 0; i < 4; i++) meter.recordOpenAiTokens('gpt-4o-mini', 1_000_000, 0);
    expect(meter.snapshot().openai.level).toBe('half');
    meter.recordOpenAiAudio('whisper-1', 3_000); // $0.30 → $0.90
    expect(meter.snapshot().openai.percent).toBeCloseTo(90);
    expect(() => meter.assertOpenAi()).toThrow(UsageLimitError);

    now = new Date('2026-11-02T12:00:00Z');
    expect(meter.snapshot().openai.level).toBe('ok');
    expect(() => meter.assertOpenAi()).not.toThrow();
  });

  it('pauses only the Google SKU that reached its limit', () => {
    now = new Date('2026-10-15T12:00:00Z');
    const meter = new UsageMeter({ openAiBudgetUsd: 5, googleFreeCaps: { place_photos: 10 }, now: clock });
    meter.recordGoogle('place_photos', 8);
    expect(meter.snapshot().google.level).toBe('almost');
    meter.recordGoogle('place_photos');
    expect(() => meter.assertGoogle('place_photos')).toThrow(/free tier/);
    expect(() => meter.assertGoogle('text_search_pro')).not.toThrow();
    // Free "IDs only" calls are counted but never limited.
    meter.recordGoogle('place_details_ids', 100_000);
    expect(() => meter.assertGoogle('place_details_ids')).not.toThrow();
    expect(meter.snapshot().google.percent).toBe(90);
  });

  it('keeps the counts across restarts', () => {
    now = new Date('2026-10-15T12:00:00Z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibi-usage-'));
    const filePath = path.join(dir, 'usage.json');
    const first = new UsageMeter({ filePath, openAiBudgetUsd: 5, now: clock });
    first.recordGoogle('text_search_pro', 42);
    first.recordOpenAiTokens('gpt-4o-mini', 2_000_000, 0);
    first.flush();

    const second = new UsageMeter({ filePath, openAiBudgetUsd: 5, now: clock });
    const snapshot = second.snapshot();
    expect(snapshot.google.skus.find(s => s.sku === 'text_search_pro')?.used).toBe(42);
    expect(snapshot.openai.spentUsd).toBeCloseTo(0.3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts a Google call only when Google answers OK', async () => {
    now = new Date('2026-10-15T12:00:00Z');
    const meter = new UsageMeter({ openAiBudgetUsd: 5, now: clock });
    const realFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('denied', { status: 403 })) as any;
    try {
      await meter.fetchGoogle('text_search_pro', 'https://places.googleapis.com/v1/places:searchText', {});
      await meter.fetchGoogle('text_search_pro', 'https://places.googleapis.com/v1/places:searchText', {});
    } finally {
      global.fetch = realFetch;
    }
    expect(meter.snapshot().google.skus.find(s => s.sku === 'text_search_pro')?.used).toBe(1);
  });
});

describe('JsonFileCache', () => {
  it('expires entries and drops the oldest past its size', () => {
    let t = 0;
    const cache = new JsonFileCache<number>(undefined, 1_000, 2, () => t);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    t = 1_001;
    expect(cache.get('b')).toBeUndefined();
  });

  it('survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibi-cache-'));
    const file = path.join(dir, 'cache.json');
    const first = new JsonFileCache<string[]>(file, 60_000, 10);
    first.set('bun cha huong lien hanoi', ['ChIJ123']);
    first.flush();
    expect(new JsonFileCache<string[]>(file, 60_000, 10).get('bun cha huong lien hanoi')).toEqual(['ChIJ123']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('TaskQueue', () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));

  it('runs two at a time in order and reports who is waiting', async () => {
    const started: string[] = [];
    const finishers: Record<string, () => void> = {};
    let waiting: string[] = [];
    const queue = new TaskQueue<{ sourceId: string }>(2, items => {
      waiting = items.map(i => i.sourceId);
    });
    const task = (id: string) => () => new Promise<void>(resolve => {
      started.push(id);
      finishers[id] = resolve;
    });
    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue({ sourceId: id }, task(id));
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(waiting).toEqual(['c', 'd']);

    finishers.a();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(waiting).toEqual(['d']);
  });

  it('keeps one place in line when a waiting import is queued again', async () => {
    let waiting: string[] = [];
    const queue = new TaskQueue<{ sourceId: string }>(1, items => {
      waiting = items.map(i => i.sourceId);
    });
    const never = () => new Promise<void>(() => {});
    queue.enqueue({ sourceId: 'busy' }, never);
    queue.enqueue({ sourceId: 'x' }, never);
    queue.enqueue({ sourceId: 'y' }, never);
    queue.enqueue({ sourceId: 'x' }, never);
    expect(waiting).toEqual(['y', 'x']);
    expect(queue.waitingCount).toBe(2);
  });
});
