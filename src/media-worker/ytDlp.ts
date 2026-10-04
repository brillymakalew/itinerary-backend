// yt-dlp wrapper: reads post details and downloads the video, captions or audio of TikTok,
// Instagram and YouTube links so the pipeline can analyze what is said and shown, not just the
// caption. yt-dlp is updated often to keep up with the platforms; see the Dockerfile.

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

export interface VideoChapter {
  startSeconds: number;
  endSeconds?: number;
  title: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface CaptionTrack {
  language: string;
  automatic: boolean;
}

export interface VideoInfo {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  webpageUrl?: string;
  chapters: VideoChapter[];
  captionTrack?: CaptionTrack;
  isLive: boolean;
}

export type YtDlpErrorKind =
  | 'private'
  | 'unavailable'
  | 'login_required'
  | 'blocked'
  | 'unsupported'
  | 'too_large'
  | 'timeout'
  | 'missing_tool'
  | 'unknown';

export class YtDlpError extends Error {
  constructor(message: string, readonly kind: YtDlpErrorKind, readonly detail?: string) {
    super(message);
  }

  /** True when trying again later (or from another network) might work. */
  get isTransient(): boolean {
    return this.kind === 'blocked' || this.kind === 'timeout' || this.kind === 'unknown';
  }
}

const INFO_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 150_000;
const CAPTIONS_TIMEOUT_MS = 60_000;
const AUDIO_TIMEOUT_MS = 300_000;

/** A video with both picture and sound, at most 720p; merged formats need ffmpeg. */
const VIDEO_FORMAT =
  'best[height<=720][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/bv*[height<=720]+ba/b';

/** Turns yt-dlp's stderr into a reason a traveler can act on. */
export function classifyYtDlpError(stderr: string): YtDlpError {
  const text = stderr.trim();
  const last = text.split('\n').filter(line => /ERROR/i.test(line)).pop() ?? text.split('\n').pop() ?? '';
  const detail = last.replace(/^ERROR:\s*/i, '').slice(0, 300);
  if (/private|only available to (approved )?followers|This account is private/i.test(text)) {
    return new YtDlpError('This post is private, so it can’t be read.', 'private', detail);
  }
  if (/not a bot|HTTP Error 429|Too Many Requests|rate.?limit|IP address is blocked|blocked/i.test(text)) {
    return new YtDlpError('The platform is blocking the server right now.', 'blocked', detail);
  }
  if (/log ?in|sign ?in|cookies|authentication|empty media response/i.test(text)) {
    return new YtDlpError('The platform asked for a login to show this post.', 'login_required', detail);
  }
  if (/Video unavailable|has been removed|no longer available|does not exist|HTTP Error 404|not available/i.test(text)) {
    return new YtDlpError('This post has been removed or is unavailable.', 'unavailable', detail);
  }
  if (/Unsupported URL/i.test(text)) {
    return new YtDlpError('This kind of link isn’t supported.', 'unsupported', detail);
  }
  if (/max-filesize|larger than max/i.test(text)) {
    return new YtDlpError('The video is too large to analyze.', 'too_large', detail);
  }
  return new YtDlpError('The video couldn’t be read.', 'unknown', detail);
}

/** Picks one caption track: the video's own language first (auto tracks keyed "xx-orig"). */
export function pickCaptionTrack(
  subtitles: Record<string, unknown> | undefined,
  automatic: Record<string, unknown> | undefined
): CaptionTrack | undefined {
  const manual = Object.keys(subtitles ?? {}).filter(k => k !== 'live_chat');
  const auto = Object.keys(automatic ?? {});
  const original = auto.find(k => k.endsWith('-orig'));
  const originalLang = original?.replace(/-orig$/, '');
  const preferred = [originalLang, 'en', 'id', 'vi'].filter((l): l is string => Boolean(l));

  for (const lang of preferred) {
    const hit = manual.find(k => k === lang || k.startsWith(`${lang}-`));
    if (hit) return { language: hit, automatic: false };
  }
  if (manual.length > 0) return { language: manual[0], automatic: false };
  if (original) return { language: original, automatic: true };
  for (const lang of ['en', 'id', 'vi']) {
    if (auto.includes(lang)) return { language: lang, automatic: true };
  }
  return undefined;
}

export function toVideoInfo(raw: any): VideoInfo {
  const chapters: VideoChapter[] = Array.isArray(raw?.chapters)
    ? raw.chapters
        .filter((c: any) => typeof c?.start_time === 'number' && typeof c?.title === 'string')
        .map((c: any) => ({ startSeconds: c.start_time, endSeconds: c.end_time, title: c.title.trim() }))
    : [];
  return {
    id: raw?.id,
    title: raw?.title || raw?.fulltitle || undefined,
    description: raw?.description || undefined,
    uploader: raw?.uploader || raw?.channel || raw?.creator || undefined,
    durationSeconds: typeof raw?.duration === 'number' ? raw.duration : undefined,
    thumbnailUrl: typeof raw?.thumbnail === 'string' ? raw.thumbnail : undefined,
    webpageUrl: raw?.webpage_url,
    chapters,
    captionTrack: pickCaptionTrack(raw?.subtitles, raw?.automatic_captions),
    isLive: raw?.is_live === true
  };
}

const NOISE = /^\[(music|applause|laughter|musik|âm nhạc|nhạc)\]$/i;

/** YouTube's json3 captions: one event per caption line, times in milliseconds. */
export function parseJson3(raw: string): TranscriptSegment[] {
  const data = JSON.parse(raw);
  const out: TranscriptSegment[] = [];
  for (const ev of data?.events ?? []) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = ev.segs.map((s: any) => s?.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text || NOISE.test(text)) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    out.push({ start, end: start + (ev.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

const vttTime = (t: string) => {
  const parts = t.trim().split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

/** WebVTT; auto-generated tracks repeat each line as it scrolls, so repeats are dropped. */
export function parseVtt(raw: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const blocks = raw.replace(/\r/g, '').split(/\n\n+/);
  let previous = '';
  for (const block of blocks) {
    const lines = block.split('\n');
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing].split('-->').map(s => s.trim().split(' ')[0]);
    const text = lines
      .slice(timing + 1)
      .map(line => line.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .filter(line => line !== previous)
      .join(' ')
      .trim();
    if (!text || NOISE.test(text)) continue;
    previous = lines[lines.length - 1].replace(/<[^>]+>/g, '').trim();
    out.push({ start: vttTime(from), end: vttTime(to), text });
  }
  return out;
}

/** Joins caption lines into ~10-second windows so long videos fit the AI prompt. */
export function mergeSegments(segments: TranscriptSegment[], minSeconds = 10, maxChars = 220): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  let current: TranscriptSegment | undefined;
  for (const seg of segments) {
    if (!current) {
      current = { ...seg };
      continue;
    }
    const tooLong = current.end - current.start >= minSeconds || current.text.length + seg.text.length > maxChars;
    if (tooLong) {
      merged.push(current);
      current = { ...seg };
    } else {
      current.end = Math.max(current.end, seg.end);
      current.text = `${current.text} ${seg.text}`;
    }
  }
  if (current) merged.push(current);
  return merged;
}

export class YtDlp {
  private availability?: Promise<boolean>;

  constructor(
    private readonly bin: string = process.env.YTDLP_BIN?.trim() || 'yt-dlp',
    private readonly jsRuntime: string = process.env.YTDLP_JS_RUNTIME?.trim() || 'node'
  ) {}

  /** Cached: whether yt-dlp can be started at all on this server. */
  isAvailable(): Promise<boolean> {
    if (!this.availability) {
      this.availability = this.exec(['--version'], 15_000)
        .then(({ stdout }) => {
          console.log(`[yt-dlp] version ${stdout.trim()}`);
          return true;
        })
        .catch(err => {
          console.warn(`[yt-dlp] not available (${this.bin}): ${err.message}`);
          return false;
        });
    }
    return this.availability;
  }

  async info(url: string): Promise<VideoInfo> {
    const { stdout } = await this.run(['-J', '--skip-download', url], INFO_TIMEOUT_MS);
    try {
      return toVideoInfo(JSON.parse(stdout));
    } catch {
      throw new YtDlpError('The video details couldn’t be read.', 'unknown', 'Invalid JSON from yt-dlp');
    }
  }

  /** Downloads the video into [dir] and returns its path. */
  async downloadVideo(url: string, dir: string, maxBytes: number): Promise<string> {
    await this.run(
      ['-f', VIDEO_FORMAT, '--max-filesize', String(maxBytes), '-o', path.join(dir, 'media.%(ext)s'), url],
      DOWNLOAD_TIMEOUT_MS
    );
    return this.findOutput(dir, 'media.');
  }

  /** Downloads one caption track and returns its lines with timestamps. */
  async downloadCaptions(url: string, dir: string, track: CaptionTrack): Promise<TranscriptSegment[]> {
    await this.run(
      [
        '--skip-download',
        track.automatic ? '--write-auto-subs' : '--write-subs',
        '--sub-langs', track.language,
        '--sub-format', 'json3/vtt/best',
        '-o', path.join(dir, 'captions.%(ext)s'),
        url
      ],
      CAPTIONS_TIMEOUT_MS
    );
    const file = this.findOutput(dir, 'captions.');
    const raw = fs.readFileSync(file, 'utf8');
    return file.endsWith('.json3') ? parseJson3(raw) : parseVtt(raw);
  }

  /** Downloads only the soundtrack (for videos without captions). */
  async downloadAudio(url: string, dir: string, maxBytes: number): Promise<string> {
    await this.run(
      ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--max-filesize', String(maxBytes), '-o', path.join(dir, 'audio.%(ext)s'), url],
      AUDIO_TIMEOUT_MS
    );
    return this.findOutput(dir, 'audio.');
  }

  private findOutput(dir: string, prefix: string): string {
    const file = fs.readdirSync(dir).find(name => name.startsWith(prefix) && !name.endsWith('.part'));
    if (!file) throw new YtDlpError('The download finished without a file.', 'unknown');
    return path.join(dir, file);
  }

  private async run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const common = ['--no-warnings', '--no-playlist', '--no-part', '--no-mtime', '--socket-timeout', '20', '--retries', '2'];
    if (this.jsRuntime) common.push('--js-runtimes', this.jsRuntime);
    if (ffmpegPath) common.push('--ffmpeg-location', ffmpegPath);
    try {
      return await this.exec([...common, ...args], timeoutMs);
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new YtDlpError('Video downloads aren’t set up on the server.', 'missing_tool');
      if (err?.killed || err?.signal === 'SIGTERM') throw new YtDlpError('Reading the video took too long.', 'timeout');
      throw classifyYtDlpError(String(err?.stderr || err?.message || ''));
    }
  }

  private exec(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            Object.assign(error, { stderr });
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        }
      );
    });
  }
}
