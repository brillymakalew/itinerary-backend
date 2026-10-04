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
    pipelineVersion: 'pipeline-2026.10.1',
    promptVersion: 'extract-v1',
  };
}
