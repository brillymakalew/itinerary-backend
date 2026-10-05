// Central runtime configuration. All secrets come from the environment (backend/.env) — never from the APK.
import path from 'path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable ${name}. See backend/.env.example.`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export interface AppConfig {
  port: number;
  apiToken: string;
  openaiApiKey: string;
  googleApiKey: string;
  metaOembedToken: string | null;
  dataDir: string;
  transcriptionModel: string;
  visionModel: string;
  extractionModel: string;
  maxUploadBytes: number;
  maxFrames: number;
  pipelineVersion: string;
  promptVersion: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Imports analyzed at the same time; the rest wait in line. */
  maxConcurrentImports: number;
  /** Estimated OpenAI spend allowed per month; new AI calls stop at 90% of it. */
  openAiMonthlyBudgetUsd: number;
  /** Overrides for Google's free calls per SKU, e.g. {"place_photos": 1000}. */
  googleFreeCaps: Record<string, number>;
  /** Disk kept for the Reels feed's videos; the least recently watched go first. */
  videoCacheMaxBytes: number;
  videoRetentionDays: number;
}

function jsonObject(name: string): Record<string, number> {
  const raw = process.env[name]?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number' && v >= 0)) as Record<string, number>;
  } catch {
    throw new Error(`${name} must be JSON like {"place_photos": 1000}.`);
  }
}

export function loadConfig(): AppConfig {
  // Shared secret the app sends as `Authorization: Bearer …` on /api routes. A public server must
  // have one, or anyone who finds it can spend the OpenAI and Google quota.
  const apiToken = optional('API_TOKEN', '');
  if (process.env.NODE_ENV === 'production' && apiToken.length < 16) {
    throw new Error('API_TOKEN must be set (16+ characters) in production. See backend/.env.example.');
  }

  return {
    port: Number(optional('PORT', '3030')),
    apiToken,
    openaiApiKey: required('OPENAI_API_KEY'),
    googleApiKey: required('GOOGLE_PLACES_API_KEY'),
    metaOembedToken: process.env.META_OEMBED_TOKEN?.trim() || null,
    dataDir: path.resolve(optional('DATA_DIR', './data')),
    supabaseUrl: optional('SUPABASE_URL', ''),
    supabaseServiceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY', ''),
    // whisper-1 is used because verbose_json returns segment timestamps (PRD §9.3 stage 4.5).
    transcriptionModel: optional('OPENAI_TRANSCRIPTION_MODEL', 'whisper-1'),
    visionModel: optional('OPENAI_VISION_MODEL', 'gpt-4o-mini'),
    extractionModel: optional('OPENAI_EXTRACTION_MODEL', 'gpt-4o-mini'),
    maxUploadBytes: Number(optional('MAX_UPLOAD_MB', '200')) * 1024 * 1024,
    maxFrames: Number(optional('MAX_FRAMES', '12')),
    maxConcurrentImports: Number(optional('MAX_CONCURRENT_IMPORTS', '2')),
    openAiMonthlyBudgetUsd: Number(optional('OPENAI_MONTHLY_BUDGET_USD', '5')),
    googleFreeCaps: jsonObject('GOOGLE_FREE_CAPS'),
    videoCacheMaxBytes: Number(optional('VIDEO_CACHE_MAX_MB', '3072')) * 1024 * 1024,
    videoRetentionDays: Number(optional('VIDEO_RETENTION_DAYS', '60')),
    // Bump with each deploy-worthy change: /health reports it, so a redeploy can be confirmed.
    pipelineVersion: 'pipeline-2026.10.8',
    promptVersion: 'extract-v1',
  };
}
