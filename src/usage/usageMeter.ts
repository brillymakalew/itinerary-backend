// Free-tier guard: counts what this server spends on OpenAI and Google Maps each month, so the app
// can warn at half and nearly used up, and new calls stop while 10% of the allowance is left.

import fs from 'fs';
import path from 'path';

export type UsageLevel = 'ok' | 'half' | 'almost' | 'paused';
export type UsageProvider = 'openai' | 'google';

export const WARN_PERCENT = 50;
export const ALMOST_PERCENT = 80;
/** New calls are refused from here on, keeping the last 10% of the free allowance untouched. */
export const STOP_PERCENT = 90;

/**
 * The Google Maps Platform SKUs this server triggers. Since March 2025 each SKU has its own
 * monthly free calls: 10,000 (Essentials), 5,000 (Pro) or 1,000 (Enterprise); "IDs only"
 * requests are free. Which SKU a Places request bills depends on the fields it asks for.
 */
export type GoogleSku =
  | 'text_search_pro'
  | 'text_search_enterprise'
  | 'place_details_ids'
  | 'place_details_pro'
  | 'place_details_enterprise'
  | 'nearby_search_pro'
  | 'place_photos';

export const GOOGLE_SKUS: Record<GoogleSku, { label: string; freePerMonth: number | null }> = {
  text_search_pro: { label: 'Place search', freePerMonth: 5_000 },
  text_search_enterprise: { label: 'Place search with ratings', freePerMonth: 1_000 },
  place_details_ids: { label: 'Photo lists', freePerMonth: null },
  place_details_pro: { label: 'Place details', freePerMonth: 5_000 },
  place_details_enterprise: { label: 'Ratings, hours and websites', freePerMonth: 1_000 },
  nearby_search_pro: { label: 'Dropped-pin lookups', freePerMonth: 5_000 },
  place_photos: { label: 'Place photos', freePerMonth: 1_000 }
};

/** USD per million tokens. Unknown models are priced like gpt-4o so estimates err high. */
const TOKEN_PRICES: [prefix: string, input: number, output: number][] = [
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4.1-nano', 0.1, 0.4],
  ['gpt-4.1-mini', 0.4, 1.6],
  ['gpt-4.1', 2, 8],
  ['gpt-4o', 2.5, 10]
];
const FALLBACK_TOKEN_PRICE = { input: 2.5, output: 10 };

/** USD per minute of audio. */
const AUDIO_PRICES: [prefix: string, perMinute: number][] = [
  ['gpt-4o-mini-transcribe', 0.003],
  ['gpt-4o-transcribe', 0.006],
  ['whisper-1', 0.006]
];
const FALLBACK_AUDIO_PRICE = 0.006;

/** Google bills by calendar month in Pacific time; OpenAI's monthly limits run on UTC. */
const GOOGLE_TIME_ZONE = 'America/Los_Angeles';
const OPENAI_TIME_ZONE = 'UTC';
const MONTHS_KEPT = 3;
const SAVE_DELAY_MS = 2_000;

export class UsageLimitError extends Error {
  constructor(message: string, readonly provider: UsageProvider) {
    super(message);
  }
}

interface OpenAiMonth {
  usd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
}

interface StoredUsage {
  version: 1;
  google: Record<string, Partial<Record<GoogleSku, number>>>;
  openai: Record<string, OpenAiMonth>;
}

export interface SkuUsage {
  sku: GoogleSku;
  label: string;
  used: number;
  /** Null for SKUs without a charge (counted for information only). */
  freePerMonth: number | null;
  percent: number;
  level: UsageLevel;
}

export interface UsageSnapshot {
  thresholds: { warn: number; almost: number; stop: number };
  openai: { month: string; spentUsd: number; budgetUsd: number; percent: number; level: UsageLevel; resetsOn: string };
  google: { month: string; percent: number; level: UsageLevel; resetsOn: string; skus: SkuUsage[] };
}

export interface UsageMeterOptions {
  /** Where the counts are kept between restarts; omitted in tests. */
  filePath?: string;
  openAiBudgetUsd: number;
  /** Overrides for Google's free calls per SKU (e.g. from GOOGLE_FREE_CAPS). */
  googleFreeCaps?: Partial<Record<GoogleSku, number>>;
  now?: () => Date;
}

export function levelFor(percent: number): UsageLevel {
  if (percent >= STOP_PERCENT) return 'paused';
  if (percent >= ALMOST_PERCENT) return 'almost';
  if (percent >= WARN_PERCENT) return 'half';
  return 'ok';
}

/** "2026-10" for a moment in [timeZone]. */
export function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  return `${year}-${month}`;
}

/** "2026-10" → "2026-11-01", the day the monthly allowance starts again. */
export function nextMonthStart(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const next = mon === 12 ? { y: year + 1, m: 1 } : { y: year, m: mon + 1 };
  return `${next.y}-${String(next.m).padStart(2, '0')}-01`;
}

export function tokenCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const match = TOKEN_PRICES.find(([prefix]) => model.startsWith(prefix));
  const price = match ? { input: match[1], output: match[2] } : FALLBACK_TOKEN_PRICE;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function audioCostUsd(model: string, seconds: number): number {
  const perMinute = AUDIO_PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? FALLBACK_AUDIO_PRICE;
  return (seconds / 60) * perMinute;
}

const percentOf = (used: number, limit: number) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 100);
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

const formatResetDay = (isoDay: string) =>
  new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export class UsageMeter {
  private data: StoredUsage = { version: 1, google: {}, openai: {} };
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly caps: Record<GoogleSku, number | null>;

  constructor(private readonly options: UsageMeterOptions) {
    this.now = options.now ?? (() => new Date());
    this.caps = Object.fromEntries(
      (Object.keys(GOOGLE_SKUS) as GoogleSku[]).map(sku => [sku, options.googleFreeCaps?.[sku] ?? GOOGLE_SKUS[sku].freePerMonth])
    ) as Record<GoogleSku, number | null>;
    this.load();
  }

  // ---- Checks before a call --------------------------------------------------------------

  /** Throws [UsageLimitError] once 90% of this month's OpenAI budget is spent. */
  assertOpenAi() {
    const { spentUsd, budgetUsd, percent, resetsOn } = this.snapshot().openai;
    if (percent >= STOP_PERCENT) {
      throw new UsageLimitError(
        `Video analysis is paused to stay within this month's OpenAI budget ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} used). It resumes on ${formatResetDay(resetsOn)}.`,
        'openai'
      );
    }
  }

  /** Throws [UsageLimitError] once 90% of [sku]'s free calls this month are used. */
  assertGoogle(sku: GoogleSku) {
    const cap = this.caps[sku];
    if (cap === null) return;
    const used = this.googleMonth()[sku] ?? 0;
    if (percentOf(used, cap) >= STOP_PERCENT) {
      const resetsOn = nextMonthStart(monthKey(this.now(), GOOGLE_TIME_ZONE));
      throw new UsageLimitError(
        `Google Maps lookups are paused to stay in the free tier (${GOOGLE_SKUS[sku].label.toLowerCase()}: ${used.toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} free calls used). They resume on ${formatResetDay(resetsOn)}.`,
        'google'
      );
    }
  }

  /** fetch() to a Google Maps Platform API, refused at the limit and counted when Google answers OK. */
  async fetchGoogle(sku: GoogleSku, url: string, init: RequestInit): Promise<Response> {
    this.assertGoogle(sku);
    const res = await fetch(url, init);
    if (res.ok) this.recordGoogle(sku);
    return res;
  }

  // ---- Recording after a call ------------------------------------------------------------

  recordGoogle(sku: GoogleSku, count = 1) {
    const month = this.googleMonth();
    month[sku] = (month[sku] ?? 0) + count;
    this.scheduleSave();
  }

  recordOpenAiTokens(model: string, inputTokens: number, outputTokens: number) {
    const month = this.openAiMonth();
    month.usd += tokenCostUsd(model, inputTokens, outputTokens);
    month.requests += 1;
    month.inputTokens += inputTokens;
    month.outputTokens += outputTokens;
    this.scheduleSave();
  }

  recordOpenAiAudio(model: string, seconds: number) {
    const month = this.openAiMonth();
    month.usd += audioCostUsd(model, seconds);
    month.requests += 1;
    month.audioSeconds += seconds;
    this.scheduleSave();
  }

  // ---- Reporting -------------------------------------------------------------------------

  snapshot(): UsageSnapshot {
    const now = this.now();
    const openAiMonthKey = monthKey(now, OPENAI_TIME_ZONE);
    const spent = this.data.openai[openAiMonthKey]?.usd ?? 0;
    const budget = this.options.openAiBudgetUsd;
    const openAiPercent = percentOf(spent, budget);

    const googleMonthKey = monthKey(now, GOOGLE_TIME_ZONE);
    const counts = this.data.google[googleMonthKey] ?? {};
    const skus: SkuUsage[] = (Object.keys(GOOGLE_SKUS) as GoogleSku[]).map(sku => {
      const used = counts[sku] ?? 0;
      const cap = this.caps[sku];
      const percent = cap === null ? 0 : percentOf(used, cap);
      return { sku, label: GOOGLE_SKUS[sku].label, used, freePerMonth: cap, percent: round(percent, 1), level: levelFor(percent) };
    });
    const googlePercent = Math.max(0, ...skus.map(s => s.percent));

    return {
      thresholds: { warn: WARN_PERCENT, almost: ALMOST_PERCENT, stop: STOP_PERCENT },
      openai: {
        month: openAiMonthKey,
        spentUsd: round(spent, 4),
        budgetUsd: budget,
        percent: round(openAiPercent, 1),
        level: levelFor(openAiPercent),
        resetsOn: nextMonthStart(openAiMonthKey)
      },
      google: {
        month: googleMonthKey,
        percent: round(googlePercent, 1),
        level: levelFor(googlePercent),
        resetsOn: nextMonthStart(googleMonthKey),
        skus
      }
    };
  }

  /** Writes pending counts now (on shutdown). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  // ---- Storage ---------------------------------------------------------------------------

  private googleMonth(): Partial<Record<GoogleSku, number>> {
    const key = monthKey(this.now(), GOOGLE_TIME_ZONE);
    return (this.data.google[key] ??= {});
  }

  private openAiMonth(): OpenAiMonth {
    const key = monthKey(this.now(), OPENAI_TIME_ZONE);
    return (this.data.openai[key] ??= { usd: 0, requests: 0, inputTokens: 0, outputTokens: 0, audioSeconds: 0 });
  }

  private load() {
    const file = this.options.filePath;
    if (!file || !fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredUsage;
      if (parsed?.version === 1) this.data = { version: 1, google: parsed.google ?? {}, openai: parsed.openai ?? {} };
    } catch (err: any) {
      // A damaged file must not stop the server; counting starts again (and errs low) instead.
      console.warn('[Usage] Could not read the usage file, starting from zero:', err?.message ?? err);
    }
  }

  private scheduleSave() {
    if (!this.options.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save() {
    const file = this.options.filePath;
    if (!file) return;
    for (const provider of ['google', 'openai'] as const) {
      const months = Object.keys(this.data[provider]).sort();
      for (const old of months.slice(0, Math.max(0, months.length - MONTHS_KEPT))) delete this.data[provider][old];
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
      fs.renameSync(temp, file);
    } catch (err: any) {
      console.warn('[Usage] Could not save usage counts:', err?.message ?? err);
    }
  }
}
