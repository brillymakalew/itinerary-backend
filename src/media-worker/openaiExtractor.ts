// Multimodal Place Extractor using OpenAI API (PRD §6.2, §9.3 Stage 4, 5, 6)

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import { SocialMetadata } from './adapters/socialAdapters';
import { mergeSegments, TranscriptSegment, VideoChapter } from './ytDlp';
import { UsageLimitError, UsageMeter } from '../usage/usageMeter';

const execFileAsync = promisify(execFile);

export interface ExtractedEvidence {
  type: 'speech' | 'caption' | 'onscreen_text' | 'visual_landmark' | 'location_tag';
  text?: string;
  start_seconds?: number;
  end_seconds?: number;
  frame_seconds?: number;
}

export interface ExtractedPlace {
  raw_name: string;
  alternate_names?: string[];
  place_type: string;
  city_or_area_hint?: string;
  country_hint?: string;
  evidence: ExtractedEvidence[];
  model_confidence: number;
  /** Practical advice the source gives about the place ("order the egg coffee"). */
  tip?: string | null;
}

export interface ExtractionResult {
  source_summary: string;
  detected_languages: string[];
  places: ExtractedPlace[];
}

export interface AnalysisOptions {
  /** Where the trip goes, e.g. "Hanoi and Sapa, Vietnam"; names are resolved near it. */
  destination?: string;
  maxPlaces?: number;
  /** Reports the current step ("Listening to the audio…") for the import's progress line. */
  onProgress?: (detail: string) => void;
}

export const DEFAULT_DESTINATION = 'Hanoi and Sapa, Vietnam';
const DEFAULT_MAX_PLACES = 12;
/** OpenAI's transcription endpoint rejects files above 25 MB. */
const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
const MAX_FRAMES = 16;
const TRANSCRIPT_CHUNK_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const CHUNK_CONCURRENCY = 3;

/** Maps OpenAI SDK failures to messages a traveler (or the server owner) can act on. */
export function describeAiError(err: any): string {
  const status = err?.status as number | undefined;
  if (status === 401) return 'The AI service rejected its API key (check OPENAI_API_KEY on the server).';
  if (status === 429) return 'The AI service is busy or out of credit. Try again in a minute.';
  if (err?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(String(err?.message))) {
    return 'AI analysis timed out. Try again.';
  }
  if (err?.name === 'APIConnectionError') return "Couldn't reach the AI service from the server.";
  return `AI analysis failed: ${err?.message ?? 'unknown error'}`;
}

/** A failed AI call as a readable error; the free-tier pause keeps its own message. */
function asAiError(err: unknown): Error {
  return err instanceof UsageLimitError ? err : new Error(describeAiError(err));
}

/** OpenAI rejects the whole request when it can't download an image URL (expired or blocked CDN link). */
export function isImageDownloadError(err: any): boolean {
  return err?.status === 400 && /image|download/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`);
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Evenly spread sample times (seconds), avoiding the very first and last frame. */
export function frameTimes(durationSeconds: number, maxFrames = MAX_FRAMES): number[] {
  if (!(durationSeconds > 0)) return [0];
  const count = Math.min(maxFrames, Math.max(4, Math.ceil(durationSeconds / 5)));
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationSeconds * 10) / count) / 10);
}

/** Accent-insensitive key: "Phở 10 Lý Quốc Sư" and "Pho 10 Ly Quoc Su" are the same place. */
export function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Combines places found in several transcript chunks, keeping every piece of evidence. */
export function mergePlaces(lists: ExtractedPlace[][]): ExtractedPlace[] {
  const byName = new Map<string, ExtractedPlace>();
  for (const place of lists.flat()) {
    const key = foldName(place.raw_name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...place, evidence: [...place.evidence] });
      continue;
    }
    existing.evidence.push(...place.evidence);
    existing.model_confidence = Math.max(existing.model_confidence, place.model_confidence);
    existing.tip = existing.tip || place.tip;
    existing.city_or_area_hint = existing.city_or_area_hint || place.city_or_area_hint;
  }
  return [...byName.values()];
}

/** Keeps only well-formed places from model output (the model occasionally omits fields). */
function sanitize(parsed: Partial<ExtractionResult>, fallbackSummary: string, maxPlaces: number): ExtractionResult {
  const places = Array.isArray(parsed.places) ? parsed.places : [];
  return {
    source_summary: parsed.source_summary || fallbackSummary,
    detected_languages: Array.isArray(parsed.detected_languages) ? parsed.detected_languages : [],
    places: places
      .filter(p => p && typeof p.raw_name === 'string' && p.raw_name.trim() !== '')
      .map(p => ({
        ...p,
        raw_name: p.raw_name.trim(),
        place_type: p.place_type || 'other',
        evidence: Array.isArray(p.evidence) ? p.evidence : [],
        model_confidence: typeof p.model_confidence === 'number' ? p.model_confidence : 0.7,
        tip: typeof p.tip === 'string' && p.tip.trim() ? p.tip.trim() : null
      }))
      .slice(0, maxPlaces)
  };
}

function rules(maxPlaces: number, material: string): string {
  return `Rules:
1. Extract only real-world physical venues or specific landmarks: restaurants, street-food stalls, cafés, bars, markets, shops, hotels, attractions, viewpoints, tours.
2. Use ONLY ${material}. Never infer places from the account name or from general knowledge of the destination.
3. Every place needs evidence: quote the words that name it ("speech" with start_seconds taken from the transcript timestamp, or "caption"), or describe the sign or landmark seen in a frame ("onscreen_text" / "visual_landmark" with frame_seconds). Leave out anything you can't cite.
4. Dishes ("bún chả", "egg coffee") are not places; only the venue serving them is ("Bún Chả Hương Liên", "Café Giảng").
5. Generic areas (Old Quarter, West Lake) count only when recommended as somewhere to go; give them place_type "area".
6. Spell names the way signs or captions do. When the transcript garbles a name that a sign or the caption shows clearly, use the correct spelling.
7. "tip": one short sentence of practical advice the source gives about that place (what to order, price, best time, how to find it), in English; null if none.
8. Return an empty "places" list when nothing specific is named or shown — that is a correct answer.
9. At most ${maxPlaces} places, most clearly recommended first.

Respond strictly with valid JSON:
{
  "source_summary": "1-2 sentence description of the content",
  "detected_languages": ["vi", "en"],
  "places": [
    {
      "raw_name": "Venue name as written or said",
      "alternate_names": ["English or local variant if any"],
      "place_type": "restaurant|cafe|bar|attraction|viewpoint|shop|hotel|market|tour|area|other",
      "city_or_area_hint": "e.g. Hoan Kiem, Hanoi",
      "country_hint": "Vietnam",
      "evidence": [
        { "type": "caption|speech|onscreen_text|visual_landmark", "text": "Exact words or what is visible", "start_seconds": null, "frame_seconds": null }
      ],
      "tip": "Order the egg coffee upstairs.",
      "model_confidence": 0.95
    }
  ]
}`;
}

export class OpenAiExtractor {
  private openai: OpenAI;
  private model: string;
  private transcriptionModel: string;

  constructor(
    apiKey: string,
    model: string = 'gpt-4o-mini',
    transcriptionModel: string = 'whisper-1',
    private readonly meter?: UsageMeter
  ) {
    // Bounded latency: one quick retry, then fail visibly instead of hanging the import.
    this.openai = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
    this.model = model;
    this.transcriptionModel = transcriptionModel;
  }

  /**
   * Stage 6: Place extraction from a caption and thumbnail only (PRD §9.3).
   */
  async extractFromMetadata(metadata: SocialMetadata, destination: string = DEFAULT_DESTINATION): Promise<ExtractionResult> {
    const textPrompt = `You are Vibi AI, a travel assistant finding places in social media posts for trip planning.
Trip destination: ${destination}.

Source details:
- Platform: ${metadata.platform}
- Author: ${metadata.authorName || 'Unknown'}
- Caption/Title: ${metadata.caption || metadata.title || 'None'}

${rules(DEFAULT_MAX_PLACES, 'the caption text and the attached thumbnail. You cannot watch the video: never claim something is "shown in the video"')}`;

    const thumbnail = metadata.thumbnailUrl?.startsWith('http') ? metadata.thumbnailUrl : undefined;
    const ask = (withThumbnail: boolean) => {
      const content: any[] = [{ type: 'text', text: textPrompt }];
      if (withThumbnail && thumbnail) {
        content.push({ type: 'image_url', image_url: { url: thumbnail, detail: 'low' } });
      }
      return this.complete(content);
    };

    try {
      let raw: string;
      try {
        raw = await ask(true);
      } catch (err) {
        // TikTok/Instagram thumbnail links expire or refuse downloads; the caption alone still counts.
        if (!thumbnail || !isImageDownloadError(err)) throw err;
        console.warn('[OpenAiExtractor] Thumbnail unusable, retrying with the caption only:', (err as any)?.message);
        raw = await ask(false);
      }
      return sanitize(JSON.parse(raw), metadata.caption || 'Extracted places', DEFAULT_MAX_PLACES);
    } catch (err) {
      console.error('[OpenAiExtractor] Extraction failed:', err);
      throw asAiError(err);
    }
  }

  /**
   * Stages 4 & 5: a downloaded or uploaded video — speech (Whisper), sampled frames and the caption
   * are analyzed together (PRD §9.3).
   */
  async extractFromVideo(
    mediaFilePath: string,
    metadata: SocialMetadata,
    workRoot: string,
    options: AnalysisOptions = {}
  ): Promise<ExtractionResult> {
    if (!fs.existsSync(mediaFilePath)) {
      throw new Error(`Media file not found at: ${mediaFilePath}`);
    }
    if (!ffmpegPath) throw new Error('Video analysis needs ffmpeg on the server.');
    const destination = options.destination || DEFAULT_DESTINATION;
    const maxPlaces = options.maxPlaces ?? DEFAULT_MAX_PLACES;
    // A private scratch directory per video, so concurrent imports never mix frames.
    fs.mkdirSync(workRoot, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(workRoot, 'job-'));

    try {
      const duration = await this.probeDuration(mediaFilePath);

      options.onProgress?.('Listening to the audio…');
      let segments: TranscriptSegment[] = [];
      try {
        const audioPath = await this.extractAudio(mediaFilePath, workDir, duration);
        if (audioPath) segments = await this.transcribe(audioPath);
      } catch (audioErr: any) {
        if (audioErr instanceof UsageLimitError) throw audioErr;
        console.warn('[OpenAiExtractor] Audio transcription skipped/failed:', audioErr?.message ?? audioErr);
      }

      options.onProgress?.('Reading signs and text in the video…');
      const frames = await this.sampleFrames(mediaFilePath, workDir, duration);

      options.onProgress?.('Asking AI to name the places…');
      const transcriptText = mergeSegments(segments)
        .map(s => `[${formatTimestamp(s.start)}] ${s.text}`)
        .join('\n')
        .slice(0, 20_000);
      const content: any[] = [
        {
          type: 'text',
          text: `You are Vibi AI, a travel assistant finding places in a travel video for a trip to ${destination}.
Video length: ${duration ? formatTimestamp(duration) : 'unknown'}.
Caption: ${metadata.caption || 'None'}
Speech transcript (timestamps are when it is said):
${transcriptText || 'No speech recorded'}

Frames sampled across the whole video follow, each labelled with its time. Read shop signs, menus and on-screen text in them.

${rules(maxPlaces, 'the caption, the speech transcript and the attached frames')}`
        }
      ];
      for (const frame of frames) {
        content.push({ type: 'text', text: `Frame at ${formatTimestamp(frame.timeSec)} (frame_seconds ${frame.timeSec}):` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: 'low' } });
      }

      try {
        const raw = await this.complete(content, 120_000);
        return sanitize(JSON.parse(raw), metadata.caption || 'Video', maxPlaces);
      } catch (err) {
        console.error('[OpenAiExtractor] Multimodal extraction failed:', err);
        throw asAiError(err);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Kept for callers of the original API name. */
  extractFromUploadedMedia(mediaFilePath: string, metadata: SocialMetadata, outputDir: string, destination?: string) {
    return this.extractFromVideo(mediaFilePath, metadata, outputDir, { destination });
  }

  /**
   * Long videos (YouTube): the transcript, chapters and description are analyzed in chunks so a
   * one-hour vlog with twenty places is covered end to end.
   */
  async extractFromTranscript(
    metadata: SocialMetadata,
    segments: TranscriptSegment[],
    chapters: VideoChapter[],
    options: AnalysisOptions = {}
  ): Promise<ExtractionResult> {
    const destination = options.destination || DEFAULT_DESTINATION;
    const maxPlaces = options.maxPlaces ?? 30;
    const lines = mergeSegments(segments).map(s => `[${formatTimestamp(s.start)}] ${s.text}`);
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      if (current.length + line.length > TRANSCRIPT_CHUNK_CHARS && current) {
        chunks.push(current);
        current = '';
      }
      current += `${line}\n`;
    }
    if (current) chunks.push(current);
    if (chunks.length === 0) chunks.push('');

    const chapterText = chapters.length
      ? chapters.map(c => `[${formatTimestamp(c.startSeconds)}] ${c.title}`).join('\n')
      : 'None';
    const description = (metadata.caption || '').slice(0, MAX_DESCRIPTION_CHARS);
    const perChunk = Math.max(8, Math.ceil(maxPlaces / chunks.length) + 4);

    const results: ExtractedPlace[][] = new Array(chunks.length);
    let done = 0;
    const work = chunks.map((chunk, index) => async () => {
      const text = `You are Vibi AI, a travel assistant finding places in a travel video for a trip to ${destination}.
Title: ${metadata.title || 'Unknown'}
Channel: ${metadata.authorName || 'Unknown'}
Description:
${description || 'None'}

Chapters:
${chapterText}

Transcript${chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : ''} — timestamps are when it is said:
${chunk || 'No transcript available'}

Chapter titles and the description count as "caption" evidence.

${rules(perChunk, 'the title, description, chapters and transcript above')}`;
      try {
        const raw = await this.complete([{ type: 'text', text }]);
        results[index] = sanitize(JSON.parse(raw), metadata.title || 'Video', perChunk).places;
      } catch (err) {
        console.error(`[OpenAiExtractor] Transcript chunk ${index + 1} failed:`, err);
        throw asAiError(err);
      } finally {
        done++;
        if (chunks.length > 1) options.onProgress?.(`Finding places in the video (${done} of ${chunks.length} parts)…`);
      }
    });
    await runLimited(work, CHUNK_CONCURRENCY);

    return {
      source_summary: metadata.title || 'Video',
      detected_languages: [],
      places: mergePlaces(results.filter(Boolean)).slice(0, maxPlaces)
    };
  }

  /** Speech to text with segment timestamps (Whisper verbose_json). */
  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    if (fs.statSync(audioPath).size > MAX_TRANSCRIPTION_BYTES) {
      throw new Error('The audio is too long to transcribe in one go.');
    }
    this.meter?.assertOpenAi();
    const transcription: any = await this.openai.audio.transcriptions.create(
      { file: fs.createReadStream(audioPath), model: this.transcriptionModel, response_format: 'verbose_json' },
      { timeout: 300_000 }
    );
    // Billed per minute of audio; verbose_json reports the length.
    const lastSegmentEnd = Array.isArray(transcription.segments) ? Number(transcription.segments.at(-1)?.end) || 0 : 0;
    this.meter?.recordOpenAiAudio(this.transcriptionModel, Number(transcription.duration) || lastSegmentEnd);
    if (Array.isArray(transcription.segments) && transcription.segments.length > 0) {
      return transcription.segments.map((seg: any) => ({ start: seg.start, end: seg.end, text: String(seg.text).trim() }));
    }
    const text = String(transcription.text || '').trim();
    return text ? [{ start: 0, end: 0, text }] : [];
  }

  /** Mono 16 kHz MP3, small enough for the transcription limit; null when there's no sound. */
  async extractAudio(mediaFilePath: string, workDir: string, durationSeconds: number | undefined): Promise<string | null> {
    if (!ffmpegPath) return null;
    const audioPath = path.join(workDir, 'audio.mp3');
    // 64 kbps keeps speech clear; long videos drop to 32 kbps to stay under 25 MB (~100 min).
    const bitrate = (durationSeconds ?? 0) > 40 * 60 ? '32k' : '64k';
    await execFileAsync(ffmpegPath, ['-i', mediaFilePath, '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-b:a', bitrate, '-y', audioPath], {
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000 ? audioPath : null;
  }

  async probeDuration(mediaFilePath: string): Promise<number | undefined> {
    if (!ffmpegPath) return undefined;
    try {
      await execFileAsync(ffmpegPath, ['-hide_banner', '-i', mediaFilePath], { timeout: 20_000 });
    } catch (err: any) {
      // Without an output ffmpeg exits with an error, but it still prints the input's duration.
      const match = String(err?.stderr ?? '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    return undefined;
  }

  private async sampleFrames(mediaFilePath: string, workDir: string, duration: number | undefined) {
    const frames: { timeSec: number; base64: string }[] = [];
    if (!ffmpegPath) return frames;
    const times = frameTimes(duration ?? 0);
    const grab = (timeSec: number, index: number) => async () => {
      const framePath = path.join(workDir, `frame_${index.toString().padStart(2, '0')}.jpg`);
      try {
        await execFileAsync(
          ffmpegPath!,
          ['-ss', String(timeSec), '-i', mediaFilePath, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', '-y', framePath],
          { timeout: 30_000 }
        );
        if (fs.existsSync(framePath)) {
          frames.push({ timeSec, base64: fs.readFileSync(framePath).toString('base64') });
        }
      } catch (frameErr: any) {
        console.warn(`[OpenAiExtractor] Frame at ${timeSec}s skipped:`, frameErr?.message ?? frameErr);
      }
    };
    await runLimited(times.map((t, i) => grab(t, i)), 4);
    return frames.sort((a, b) => a.timeSec - b.timeSec);
  }

  private async complete(content: any[], timeoutMs = 60_000): Promise<string> {
    this.meter?.assertOpenAi();
    const response = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        temperature: 0.2
      },
      { timeout: timeoutMs }
    );
    if (response.usage) {
      this.meter?.recordOpenAiTokens(response.model || this.model, response.usage.prompt_tokens ?? 0, response.usage.completion_tokens ?? 0);
    }
    return response.choices[0]?.message?.content || '{}';
  }
}

/** Runs async tasks with at most [limit] in flight. */
export async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  });
  await Promise.all(workers);
}
