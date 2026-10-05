// End-to-End Media Processing Pipeline (PRD §9.3 & §9.4 & Appendix A)

import fs from 'fs';
import path from 'path';
import { ClientPreview, SocialAdapters, SocialMetadata, SourcePlatform } from './adapters/socialAdapters';
import { DEFAULT_DESTINATION, ExtractionResult, foldName, OpenAiExtractor } from './openaiExtractor';
import { GooglePlacesResolver, ProviderMatch, RESOLUTION_CACHE_TTL_MS, ResolvedCandidate } from './googlePlacesResolver';
import { TranscriptSegment, VideoInfo, YtDlp, YtDlpError } from './ytDlp';
import { PlaceLookupError, PlaceLookupService } from '../places/placeLookup';
import { AppConfig } from '../config';
import { getSupabaseClient } from '../supabase';
import { JsonFileCache } from '../places/fileCache';
import { UsageMeter } from '../usage/usageMeter';
import { TaskQueue } from './taskQueue';
import { SupabaseClient } from '@supabase/supabase-js';

export type PipelineStage =
  /** Kept to analyze later: nothing has been read or spent yet. */
  | 'saved'
  | 'added'
  | 'fetching_metadata'
  | 'analyzing_audio'
  | 'analyzing_frames'
  | 'resolving_places'
  | 'ready_to_review'
  | 'needs_media'
  | 'needs_user_correction'
  | 'completed'
  | 'failed';

/** Where a job's content comes from; 'upload' is a video sent from the phone. */
export type JobPlatform = SourcePlatform | 'upload';

const ACTIVE_STAGES: PipelineStage[] = ['added', 'fetching_metadata', 'analyzing_audio', 'analyzing_frames', 'resolving_places'];

/** Hard ceilings so a job always ends in a visible state instead of hanging. */
const JOB_TIMEOUT_MS: Record<JobPlatform, number> = {
  tiktok: 300_000,
  instagram: 300_000,
  youtube: 900_000,
  google_maps: 60_000,
  other_url: 120_000,
  upload: 600_000
};
/** Short posts mention a handful of places; long YouTube guides can list dozens. */
const MAX_PLACES_SHORT = 12;
const MAX_PLACES_LONG = 30;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
/** Social videos longer than this are treated as long videos (captions/audio, no frames). */
const MAX_FULL_VIDEO_SECONDS = 15 * 60;
/** Audio is transcribed only up to this length (the transcription service limit is ~100 min). */
const MAX_TRANSCRIBE_SECONDS = 100 * 60;
const UPLOAD_RETENTION_DAYS = 30;
const SYNC_DEBOUNCE_MS = 700;

export interface ImportOptions {
  /** Re-run analysis even if the server already knows this link (used by Retry). */
  force?: boolean;
  preview?: ClientPreview;
  createdBy?: string;
  createdByName?: string;
  destination?: string;
  /** The import being retried; keeps its id (and finds an uploaded video) after a server restart. */
  sourceId?: string;
  /** False: keep the link to analyze later, without any AI or Google calls yet. */
  analyze?: boolean;
}

/** Ids the app sends back for a retry; anything else gets a fresh id. */
const SOURCE_ID_PATTERN = /^src_[A-Za-z0-9_-]{4,100}$/;

export interface SourceJob {
  sourceId: string;
  tripId: string;
  url: string;
  platform: JobPlatform;
  status: PipelineStage;
  /** Human-readable progress, e.g. "Matching 3 places on Google Maps…". */
  statusDetail?: string;
  creatorName?: string;
  caption?: string;
  thumbnailUrl?: string;
  candidateCount: number;
  reviewedCount: number;
  candidates: ResolvedCandidate[];
  createdAt: string;
  updatedAt: string;
  stageStartedAt: string;
  error?: string;
  createdBy?: string;
  createdByName?: string;
  durationSeconds?: number;
  /** What the app read on the phone; used when the server can't read the post itself. */
  clientPreview?: ClientPreview;
  destination?: string;
  /** Uploaded video kept on the server so "Analyze again" works. */
  mediaPath?: string;
  /** 1 = next to start, while the job waits for a free slot. */
  queuePosition?: number;
}

/** The job as the app sees it (no server paths or internal state). */
export function publicJob(job: SourceJob) {
  const { clientPreview, mediaPath, destination, ...rest } = job;
  return rest;
}

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const asYtDlpError = (err: unknown): YtDlpError =>
  err instanceof YtDlpError ? err : new YtDlpError('The video couldn’t be read.', 'unknown', String((err as any)?.message ?? err));

/**
 * Merges candidates that resolved to the same Google place (a video naming a café twice), or
 * that share a name when neither found a match. Evidence from every mention is kept.
 */
export function dedupeCandidates(candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const byKey = new Map<string, ResolvedCandidate>();
  for (const candidate of candidates) {
    const key = candidate.topMatch?.providerPlaceId ?? `name:${foldName(candidate.rawName)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate, evidence: [...candidate.evidence] });
      continue;
    }
    const seen = new Set(existing.evidence.map(e => `${e.type}|${e.text ?? ''}`));
    for (const ev of candidate.evidence) {
      if (!seen.has(`${ev.type}|${ev.text ?? ''}`)) existing.evidence.push(ev);
    }
    existing.modelConfidence = Math.max(existing.modelConfidence, candidate.modelConfidence);
    existing.tip = existing.tip || candidate.tip;
  }
  return [...byKey.values()];
}

/**
 * Whole cities, districts, provinces and countries ("political" in Google's types, e.g. Hội An is
 * a sublocality): somewhere to go, not a stop to plan. Anything also listed as an attraction or a
 * business stays.
 */
export function isCityLevel(candidate: ResolvedCandidate): boolean {
  const types = candidate.topMatch?.types ?? [];
  const administrative = types.includes('political') || types.includes('country') || types.includes('colloquial_area');
  const visitable = types.some(t => t === 'tourist_attraction' || t === 'establishment' || t === 'point_of_interest');
  return administrative && !visitable;
}

/** The leading town of a destination ("Hanoi and Sapa, Vietnam" → "Hanoi, Vietnam") for searches. */
export function searchArea(destination: string): string {
  const [places, country] = destination.split(',').map(s => s.trim());
  const first = places?.split(/\s+and\s+|&|\//i)[0]?.trim();
  return [first, country].filter(Boolean).join(', ') || destination;
}

export class MediaProcessingPipeline {
  private extractor: OpenAiExtractor;
  private placesResolver: GooglePlacesResolver;
  private ytdlp: YtDlp;
  private placeLookup: PlaceLookupService;
  private jobs: Map<string, SourceJob> = new Map();
  /** Incremented per (re)run so results from an abandoned (timed-out) run are ignored. */
  private runIds: Map<string, number> = new Map();
  private storageDir: string;
  private workRoot: string;
  private supabase: SupabaseClient | null;
  private syncTimers = new Map<string, NodeJS.Timeout>();
  /** Flipped off if the database hasn't had the newer columns added yet (see supabase/migrations). */
  private extendedColumns = { sources: true, candidates: true };
  /** Imports wait here for a free slot (MAX_CONCURRENT_IMPORTS at a time). */
  private queue: TaskQueue<SourceJob>;

  constructor(
    config: AppConfig,
    ytdlp = new YtDlp(),
    placeLookup = new PlaceLookupService(config.googleApiKey),
    private readonly meter?: UsageMeter
  ) {
    this.extractor = new OpenAiExtractor(config.openaiApiKey, config.visionModel, config.transcriptionModel, meter);
    const matchCache = new JsonFileCache<ProviderMatch[]>(path.resolve(config.dataDir, 'cache', 'place-matches.json'), RESOLUTION_CACHE_TTL_MS, 10_000);
    this.placesResolver = new GooglePlacesResolver(config.googleApiKey, meter, matchCache);
    this.queue = new TaskQueue<SourceJob>(
      config.maxConcurrentImports,
      waiting => waiting.forEach((job, index) => this.showQueuePosition(job, index)),
      job => {
        job.queuePosition = undefined;
      }
    );
    this.ytdlp = ytdlp;
    this.placeLookup = placeLookup;
    this.supabase = getSupabaseClient(config);
    this.storageDir = path.resolve(config.dataDir, 'uploads');
    this.workRoot = path.resolve(config.dataDir, 'work');
    fs.mkdirSync(this.storageDir, { recursive: true });
    // Scratch files from a previous run are never needed again.
    fs.rmSync(this.workRoot, { recursive: true, force: true });
    fs.mkdirSync(this.workRoot, { recursive: true });
    this.pruneOldUploads();
    void this.ytdlp.isAvailable();
    void this.markInterruptedSources();
  }

  /**
   * Stage 1-7: Process URL Import Asynchronously (PRD §9.3 & §18.1).
   * The same link for the same trip reuses its job; a finished or failed job only re-runs
   * when [options.force] is set (the app's Retry), and a running job is never started twice.
   */
  startImportJob(tripId: string, rawUrl: string, options: ImportOptions = {}): SourceJob {
    if (rawUrl.startsWith('upload://')) return this.restartUpload(tripId, rawUrl, options);
    const { normalizedUrl, platform } = SocialAdapters.normalizeUrl(rawUrl);
    const analyze = options.analyze !== false;
    const requestedId = options.sourceId && SOURCE_ID_PATTERN.test(options.sourceId) ? options.sourceId : undefined;

    const sameLink = (j: SourceJob | undefined) => j && j.tripId === tripId && j.url === normalizedUrl ? j : undefined;
    const existing = [...this.jobs.values()].find(j => sameLink(j)) ?? sameLink(requestedId ? this.jobs.get(requestedId) : undefined);
    if (existing) {
      // Saving a link that's already here changes nothing.
      if (!analyze) return existing;
      const running = ACTIVE_STAGES.includes(existing.status);
      const waiting = existing.status === 'saved' || existing.status === 'failed';
      if (running || (!options.force && !waiting)) return existing;
      if (options.preview) existing.clientPreview = options.preview;
      if (options.destination) existing.destination = options.destination;
      this.resetJob(existing);
      this.startLinkJob(existing);
      return existing;
    }

    const now = new Date().toISOString();
    const job: SourceJob = {
      // A retry after a server restart keeps its id, so both phones keep one card for it.
      sourceId: requestedId && !this.jobs.has(requestedId) ? requestedId : `src_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tripId,
      url: normalizedUrl,
      platform,
      status: analyze ? 'added' : 'saved',
      statusDetail: !analyze ? undefined : platform === 'google_maps' ? 'Opening the Google Maps link…' : 'Waiting to start…',
      candidateCount: 0,
      reviewedCount: 0,
      candidates: [],
      createdAt: now,
      updatedAt: now,
      stageStartedAt: now,
      createdBy: options.createdBy,
      createdByName: options.createdByName,
      clientPreview: options.preview,
      destination: options.destination
    };
    this.jobs.set(job.sourceId, job);
    if (analyze) this.startLinkJob(job);
    else this.keepForLater(job);
    return job;
  }

  /** A link saved for later shows what the phone read about it; nothing else is fetched. */
  private keepForLater(job: SourceJob) {
    const platform: SourcePlatform = job.platform === 'upload' ? 'other_url' : job.platform;
    const meta = SocialAdapters.fromClientPreview(job.url, platform, job.clientPreview);
    if (meta) {
      job.caption = (platform === 'youtube' ? meta.title : meta.caption || meta.title) ?? job.caption;
      job.creatorName = meta.authorName ?? job.creatorName;
      job.thumbnailUrl = meta.thumbnailUrl ?? job.thumbnailUrl;
    }
    this.setStage(job, 'saved', undefined);
  }

  /**
   * Accepts a user-provided video for a source (PRD §9.2 & §18.2) and analyzes it in the
   * background; callers poll GET /api/sources/:id like a link import. The file is kept so the
   * import can be analyzed again.
   */
  startMediaUpload(
    sourceId: string,
    tripId: string,
    tempFilePath: string,
    originalName: string,
    options: Omit<ImportOptions, 'force' | 'preview' | 'sourceId'> = {}
  ): SourceJob {
    let job = this.jobs.get(sourceId);
    if (job && ACTIVE_STAGES.includes(job.status) && job.status !== 'analyzing_audio') {
      fs.promises.unlink(tempFilePath).catch(() => {});
      return job;
    }
    const mediaPath = this.storeUpload(sourceId, tempFilePath, originalName);
    if (!job) {
      const now = new Date().toISOString();
      job = {
        sourceId,
        tripId,
        url: `upload://${originalName}`,
        platform: 'upload',
        status: 'analyzing_audio',
        caption: originalName,
        candidateCount: 0,
        reviewedCount: 0,
        candidates: [],
        createdAt: now,
        updatedAt: now,
        stageStartedAt: now
      };
      this.jobs.set(sourceId, job);
    } else {
      this.resetJob(job);
    }
    job.mediaPath = mediaPath;
    job.createdBy = job.createdBy ?? options.createdBy;
    job.createdByName = job.createdByName ?? options.createdByName;
    job.destination = options.destination ?? job.destination;
    this.queue.enqueue(job, () => this.runUploadJob(job));
    return job;
  }

  /** Whether yt-dlp works here, i.e. TikTok/Instagram/YouTube videos can be downloaded. */
  canDownloadVideos(): Promise<boolean> {
    return this.ytdlp.isAvailable();
  }

  getJob(sourceId: string): SourceJob | undefined {
    return this.jobs.get(sourceId);
  }

  getJobsForTrip(tripId: string): SourceJob[] {
    return Array.from(this.jobs.values()).filter(j => j.tripId === tripId);
  }

  updateCandidateReview(candidateId: string, state: ResolvedCandidate['reviewState']): boolean {
    for (const job of this.jobs.values()) {
      const cand = job.candidates.find(c => c.id === candidateId);
      if (cand) {
        cand.reviewState = state;
        job.reviewedCount = job.candidates.filter(c => c.reviewState !== 'PENDING').length;
        if (job.reviewedCount === job.candidates.length) {
          this.setStage(job, 'completed', 'All places reviewed');
        }
        job.updatedAt = new Date().toISOString();
        // Only this candidate's state: the other phone may have reviewed others meanwhile.
        void this.syncCandidateReview(candidateId, state);
        return true;
      }
    }
    return false;
  }

  // ---- Queue -----------------------------------------------------------------------------

  /** Google Maps links take a second and no AI, so they never wait behind videos. */
  private startLinkJob(job: SourceJob) {
    if (job.platform === 'google_maps') void this.runLinkJob(job);
    else this.queue.enqueue(job, () => this.runLinkJob(job));
  }

  private showQueuePosition(job: SourceJob, index: number) {
    const detail = index === 0 ? 'Next in line…' : `Waiting in line (${index} ahead)…`;
    job.queuePosition = index + 1;
    if (job.status !== 'added' || job.statusDetail !== detail) this.setStage(job, 'added', detail);
  }

  /** Refuses an import the free tier can't cover before anything is spent on it. */
  private checkFreeTier(job: SourceJob) {
    if (!this.meter) return;
    if (job.platform !== 'google_maps') this.meter.assertOpenAi();
    this.meter.assertGoogle('text_search_pro');
  }

  // ---- Runs ------------------------------------------------------------------------------

  private runLinkJob(job: SourceJob): Promise<void> {
    const runId = this.beginRun(job);
    const work = (async () => {
      this.checkFreeTier(job);
      if (job.platform !== 'google_maps') this.setStage(job, 'fetching_metadata', 'Reading the post…');
      switch (job.platform) {
        case 'google_maps':
          return this.runMapsLink(job, runId);
        case 'tiktok':
        case 'instagram':
          return this.runSocialVideo(job, runId);
        case 'youtube':
          return this.runYouTube(job, runId);
        default:
          return this.runWebPage(job, runId);
      }
    })();
    return this.supervise(job, runId, work, JOB_TIMEOUT_MS[job.platform]);
  }

  private runUploadJob(job: SourceJob): Promise<void> {
    const runId = this.beginRun(job);
    const meta: SocialMetadata = {
      platform: job.platform === 'upload' ? 'other_url' : job.platform,
      originalUrl: job.url,
      normalizedUrl: job.url,
      caption: job.caption,
      hasAnalyzableMedia: true
    };
    const work = (async () => {
      this.checkFreeTier(job);
      this.setStage(job, 'analyzing_audio', 'Listening to the audio…');
      await this.analyzeVideoFile(job, runId, job.mediaPath!, meta, 'No places were found in this video.');
    })();
    return this.supervise(job, runId, work, JOB_TIMEOUT_MS.upload);
  }

  /** "Analyze again" on an uploaded video, finding the stored file even after a restart. */
  private restartUpload(tripId: string, url: string, options: ImportOptions): SourceJob {
    const job =
      (options.sourceId && this.jobs.get(options.sourceId)) ||
      [...this.jobs.values()].find(j => j.tripId === tripId && j.url === url);
    if (job && ACTIVE_STAGES.includes(job.status)) return job;
    const sourceId = job ? job.sourceId : options.sourceId;
    const mediaPath = job?.mediaPath ?? (sourceId ? this.findUpload(sourceId) : undefined);
    if (!sourceId || !mediaPath || !fs.existsSync(mediaPath)) {
      throw new Error('The uploaded video is no longer on the server. Upload it again.');
    }
    const now = new Date().toISOString();
    const target: SourceJob = job || {
      sourceId,
      tripId,
      url,
      platform: 'upload',
      status: 'analyzing_audio',
      caption: url.replace('upload://', ''),
      candidateCount: 0,
      reviewedCount: 0,
      candidates: [],
      createdAt: now,
      updatedAt: now,
      stageStartedAt: now,
      createdBy: options.createdBy,
      createdByName: options.createdByName
    };
    this.jobs.set(sourceId, target);
    this.resetJob(target);
    target.mediaPath = mediaPath;
    target.destination = options.destination ?? target.destination;
    this.queue.enqueue(target, () => this.runUploadJob(target));
    return target;
  }

  /** TikTok and Instagram: download the video and analyze speech, frames and caption together. */
  private async runSocialVideo(job: SourceJob, runId: number) {
    const canDownload = await this.ytdlp.isAvailable();
    let info: VideoInfo | undefined;
    let failure: YtDlpError | undefined;
    if (canDownload) {
      try {
        info = await this.ytdlp.info(job.url);
      } catch (err) {
        failure = asYtDlpError(err);
        console.warn(`[Pipeline] ${job.sourceId} details: ${failure.kind} — ${failure.detail ?? failure.message}`);
      }
    }
    if (!this.isCurrentRun(job, runId)) return;

    const meta = await this.metadataFor(job, info);
    if (!this.isCurrentRun(job, runId)) return;

    const gone = failure?.kind === 'private' || failure?.kind === 'unavailable';
    const isLong = (info?.durationSeconds ?? 0) > MAX_FULL_VIDEO_SECONDS;
    let videoPath: string | undefined;
    const workDir = this.makeWorkDir(job, runId);
    try {
      if (canDownload && !gone && !isLong) {
        this.setStage(job, 'fetching_metadata', 'Downloading the video…');
        try {
          videoPath = await this.ytdlp.downloadVideo(job.url, workDir, MAX_VIDEO_BYTES);
        } catch (err) {
          failure = asYtDlpError(err);
          console.warn(`[Pipeline] ${job.sourceId} download: ${failure.kind} — ${failure.detail ?? failure.message}`);
        }
        if (!this.isCurrentRun(job, runId)) return;
      }

      if (videoPath) {
        await this.analyzeVideoFile(job, runId, videoPath, meta, 'No places were found in this video.');
      } else if (meta.hasMetadata && meta.caption) {
        this.setStage(job, 'analyzing_frames', 'Finding places in the caption…');
        const extraction = await this.extractor.extractFromMetadata(meta, this.destinationOf(job));
        if (!this.isCurrentRun(job, runId)) return;
        await this.resolveAndFinish(job, runId, extraction, 'needs_media', this.captionOnlyMessage(failure));
      } else {
        this.setStage(job, 'needs_media', this.unreadableMessage(job, failure));
        await this.flushSync(job);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** YouTube: read the captions (or transcribe the audio) plus chapters and description. */
  private async runYouTube(job: SourceJob, runId: number) {
    // YouTube refuses data-centre servers, so the phone reads the captions and sends them along.
    const fromPhone = job.clientPreview?.transcript ?? [];
    if (fromPhone.length > 0) {
      const meta = await this.metadataFor(job, undefined);
      job.durationSeconds = job.clientPreview?.durationSeconds ?? job.durationSeconds;
      if (!this.isCurrentRun(job, runId)) return;
      console.log(`[Pipeline] ${job.sourceId}: using the ${fromPhone.length}-line transcript the app read on the phone`);
      this.setStage(job, 'analyzing_frames', 'Finding places in the video…');
      const segments = fromPhone.map(line => ({ start: line.start, end: line.start, text: line.text }));
      const extraction = await this.extractor.extractFromTranscript(meta, segments, [], {
        destination: this.destinationOf(job),
        maxPlaces: MAX_PLACES_LONG,
        onProgress: detail => this.updateDetail(job, runId, detail)
      });
      if (!this.isCurrentRun(job, runId)) return;
      await this.resolveAndFinish(job, runId, extraction, 'needs_user_correction', 'No specific places were mentioned in this video.');
      return;
    }

    const canDownload = await this.ytdlp.isAvailable();
    let info: VideoInfo | undefined;
    let failure: YtDlpError | undefined;
    if (canDownload) {
      this.setStage(job, 'fetching_metadata', 'Reading the video details…');
      try {
        info = await this.ytdlp.info(job.url);
      } catch (err) {
        failure = asYtDlpError(err);
        console.warn(`[Pipeline] ${job.sourceId} details: ${failure.kind} — ${failure.detail ?? failure.message}`);
      }
    }
    if (!this.isCurrentRun(job, runId)) return;
    if (info?.isLive) {
      job.error = 'Live streams can’t be analyzed. Try again once the stream has ended.';
      this.setStage(job, 'failed', undefined);
      await this.flushSync(job);
      return;
    }

    const meta = await this.metadataFor(job, info);
    if (!this.isCurrentRun(job, runId)) return;
    if (!info) {
      // The server couldn't open the video; what the phone read (title, description) still helps.
      if (!meta.hasMetadata || !meta.caption) {
        job.error = failure ? `${failure.message} Try again later.` : 'Couldn’t read this YouTube video.';
        this.setStage(job, 'failed', undefined);
        await this.flushSync(job);
        return;
      }
      this.setStage(job, 'analyzing_frames', 'Finding places in the description…');
      const extraction = await this.extractor.extractFromTranscript(meta, [], [], {
        destination: this.destinationOf(job),
        maxPlaces: MAX_PLACES_LONG
      });
      if (!this.isCurrentRun(job, runId)) return;
      await this.resolveAndFinish(job, runId, extraction, 'needs_user_correction', 'No specific places were found in the description.');
      return;
    }

    const workDir = this.makeWorkDir(job, runId);
    try {
      let segments: TranscriptSegment[] = [];
      if (info.captionTrack) {
        this.setStage(job, 'analyzing_audio', 'Reading the captions…');
        try {
          segments = await this.ytdlp.downloadCaptions(job.url, workDir, info.captionTrack);
        } catch (err) {
          console.warn(`[Pipeline] ${job.sourceId} captions failed:`, asYtDlpError(err).detail);
        }
        if (!this.isCurrentRun(job, runId)) return;
      }
      if (segments.length === 0 && (info.durationSeconds ?? 0) <= MAX_TRANSCRIBE_SECONDS) {
        this.setStage(job, 'analyzing_audio', 'Downloading the audio…');
        try {
          const audio = await this.ytdlp.downloadAudio(job.url, workDir, MAX_AUDIO_BYTES);
          if (!this.isCurrentRun(job, runId)) return;
          this.setStage(job, 'analyzing_audio', 'Transcribing the audio…');
          const mp3 = await this.extractor.extractAudio(audio, workDir, info.durationSeconds);
          if (mp3) segments = await this.extractor.transcribe(mp3);
        } catch (err: any) {
          console.warn(`[Pipeline] ${job.sourceId} audio failed:`, err?.detail ?? err?.message ?? err);
        }
        if (!this.isCurrentRun(job, runId)) return;
      }

      this.setStage(job, 'analyzing_frames', 'Finding places in the video…');
      const extraction = await this.extractor.extractFromTranscript(meta, segments, info.chapters, {
        destination: this.destinationOf(job),
        maxPlaces: MAX_PLACES_LONG,
        onProgress: detail => this.updateDetail(job, runId, detail)
      });
      if (!this.isCurrentRun(job, runId)) return;
      await this.resolveAndFinish(job, runId, extraction, 'needs_user_correction', 'No specific places were mentioned in this video.');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Google Maps links name one place exactly; no AI needed. */
  private async runMapsLink(job: SourceJob, runId: number) {
    this.setStage(job, 'resolving_places', 'Opening the Google Maps link…');
    let place;
    try {
      place = await this.placeLookup.resolveMapsLink(job.url);
    } catch (err: any) {
      if (!this.isCurrentRun(job, runId)) return;
      job.error = err instanceof PlaceLookupError ? err.message : 'Couldn’t open that Google Maps link. Try again.';
      this.setStage(job, 'failed', undefined);
      await this.flushSync(job);
      return;
    }
    if (!this.isCurrentRun(job, runId)) return;
    job.caption = place.name;
    const candidate: ResolvedCandidate = {
      id: `cand_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sourceId: job.sourceId,
      rawName: place.name,
      category: place.category === 'OTHER' ? 'ATTRACTION' : place.category,
      areaHint: place.address,
      modelConfidence: 1,
      resolutionConfidence: 0.99,
      confidenceBand: 'HIGH',
      reviewState: 'PENDING',
      evidence: [{ type: 'location_tag', text: 'Shared from Google Maps', chipLabel: 'Google Maps link' }],
      topMatch: {
        providerPlaceId: place.providerPlaceId,
        name: place.name,
        address: place.address,
        location: place.location,
        rating: place.rating,
        priceLevel: place.priceLevel,
        category: place.category
      },
      options: [{ providerPlaceId: place.providerPlaceId, name: place.name, address: place.address, location: place.location, confidence: 0.99 }]
    };
    job.candidates = [candidate];
    job.candidateCount = 1;
    this.setStage(job, 'ready_to_review', 'Found 1 place');
    await this.flushSync(job);
  }

  /** Ordinary web pages (blogs, Wikipedia, travel guides): their text and preview image. */
  private async runWebPage(job: SourceJob, runId: number) {
    const meta = await this.metadataFor(job, undefined);
    if (!this.isCurrentRun(job, runId)) return;
    if (!meta.hasMetadata) {
      job.error = "Couldn't read this page (it may be private, removed, or blocking apps). Check the link and try again.";
      this.setStage(job, 'failed', undefined);
      await this.flushSync(job);
      return;
    }
    this.setStage(job, 'analyzing_frames', 'Asking AI to spot places on the page…');
    const extraction = await this.extractor.extractFromMetadata(meta, this.destinationOf(job));
    if (!this.isCurrentRun(job, runId)) return;
    await this.resolveAndFinish(job, runId, extraction, 'needs_user_correction', 'No specific places found on this page.');
  }

  private async analyzeVideoFile(job: SourceJob, runId: number, filePath: string, meta: SocialMetadata, emptyDetail: string) {
    this.setStage(job, 'analyzing_audio', 'Listening to the audio…');
    const extraction = await this.extractor.extractFromVideo(filePath, meta, this.workRoot, {
      destination: this.destinationOf(job),
      maxPlaces: (job.durationSeconds ?? 0) > MAX_FULL_VIDEO_SECONDS ? MAX_PLACES_LONG : MAX_PLACES_SHORT,
      onProgress: detail => this.updateDetail(job, runId, detail)
    });
    if (!this.isCurrentRun(job, runId)) return;
    if (extraction.source_summary && (!job.caption || job.platform === 'upload')) {
      job.caption = extraction.source_summary;
    }
    await this.resolveAndFinish(job, runId, extraction, 'needs_user_correction', emptyDetail);
  }

  /** Post details from yt-dlp, the phone's preview, or oEmbed / Open Graph tags (in that order). */
  private async metadataFor(job: SourceJob, info: VideoInfo | undefined): Promise<SocialMetadata> {
    const platform: SourcePlatform = job.platform === 'upload' ? 'other_url' : job.platform;
    const fromApp = SocialAdapters.fromClientPreview(job.url, platform, job.clientPreview);
    let meta: SocialMetadata;
    if (info && (info.description || info.title)) {
      meta = {
        platform,
        originalUrl: job.url,
        normalizedUrl: job.url,
        title: info.title,
        caption: info.description || info.title,
        authorName: info.uploader,
        thumbnailUrl: info.thumbnailUrl,
        hasAnalyzableMedia: true,
        hasMetadata: true
      };
      job.durationSeconds = info.durationSeconds;
    } else if (fromApp) {
      console.log(`[Pipeline] ${job.sourceId}: using the caption the app read on the phone`);
      meta = fromApp;
    } else {
      meta = await SocialAdapters.fetchMetadata(job.url, platform);
    }
    job.creatorName = meta.authorName ?? job.creatorName;
    const shownTitle = platform === 'youtube' ? meta.title : meta.caption || meta.title;
    // A page that couldn't be read reports its own URL as the title; that's not a caption.
    if (shownTitle && meta.hasMetadata !== false) job.caption = shownTitle;
    job.thumbnailUrl = meta.thumbnailUrl ?? job.thumbnailUrl;
    job.updatedAt = new Date().toISOString();
    return meta;
  }

  private captionOnlyMessage(failure: YtDlpError | undefined): string {
    const why = failure ? ` The video couldn’t be downloaded (${failure.message.replace(/\.$/, '').toLowerCase()}).` : '';
    return `No places in the caption.${why} Save the video and share it to Vibi so speech and signs can be analyzed.`;
  }

  private unreadableMessage(job: SourceJob, failure: YtDlpError | undefined): string {
    if (failure?.kind === 'private') return 'This post is private, so Vibi can’t read it. Save the video and share it to Vibi instead.';
    if (failure?.kind === 'unavailable') return 'This post was removed or isn’t available any more.';
    if (job.platform === 'instagram') {
      return "Instagram didn't share this Reel with the server. Save the video and share it to Vibi to analyze it.";
    }
    const why = failure ? ` (${failure.message.replace(/\.$/, '').toLowerCase()})` : '';
    return `Couldn't read this post${why}. Save the video and share it to Vibi so speech and signs can be analyzed.`;
  }

  private destinationOf(job: SourceJob): string {
    return job.destination?.trim() || DEFAULT_DESTINATION;
  }

  private async resolveAndFinish(
    job: SourceJob,
    runId: number,
    extraction: ExtractionResult,
    whenEmpty: PipelineStage,
    emptyDetail: string
  ) {
    const isLong = job.platform === 'youtube' || (job.durationSeconds ?? 0) > MAX_FULL_VIDEO_SECONDS;
    const places = extraction.places.slice(0, isLong ? MAX_PLACES_LONG : MAX_PLACES_SHORT);
    if (places.length > 0) {
      this.setStage(job, 'resolving_places', `Matching ${plural(places.length, 'place')} on Google Maps…`);
    }
    // Resolve in parallel: each lookup is an independent network call.
    const area = searchArea(this.destinationOf(job));
    const resolved = await Promise.all(places.map(place => this.placesResolver.resolve(place, job.sourceId, area)));
    if (!this.isCurrentRun(job, runId)) return;

    const unique = dedupeCandidates(resolved);
    // "10 days in Vietnam: Hanoi, Sapa, Hoi An…" names cities, which aren't places to add to a day.
    const cities = unique.filter(isCityLevel);
    job.candidates = unique.filter(c => !isCityLevel(c));
    job.candidateCount = job.candidates.length;
    if (job.candidates.length > 0) {
      this.setStage(job, 'ready_to_review', `Found ${plural(job.candidates.length, 'place')}`);
    } else if (cities.length > 0) {
      const names = cities.slice(0, 4).map(c => c.topMatch?.name ?? c.rawName).join(', ');
      this.setStage(job, 'needs_user_correction', `This only names cities (${names}), not specific places to visit.`);
    } else {
      this.setStage(job, whenEmpty, emptyDetail);
    }
    await this.flushSync(job);
  }

  /** Converts any failure or timeout into a visible `failed` state with a readable reason. */
  private async supervise(job: SourceJob, runId: number, work: Promise<void>, timeoutMs: number): Promise<void> {
    try {
      await withTimeout(work, timeoutMs, `Timed out after ${Math.round(timeoutMs / 1000)}s`);
    } catch (err: any) {
      if (!this.isCurrentRun(job, runId)) return;
      console.error(`[Pipeline] ${job.sourceId} failed:`, err?.message || err);
      job.error = err instanceof TimeoutError
        ? 'Analysis took too long and was stopped. Tap Retry to try again.'
        : err?.message || 'Processing failed';
      this.setStage(job, 'failed', undefined);
      this.runIds.set(job.sourceId, runId + 1); // late results from this run are now stale
      this.flushSync(job).catch(() => {});
    }
  }

  private beginRun(job: SourceJob): number {
    const runId = (this.runIds.get(job.sourceId) ?? 0) + 1;
    this.runIds.set(job.sourceId, runId);
    return runId;
  }

  private isCurrentRun(job: SourceJob, runId: number): boolean {
    return this.runIds.get(job.sourceId) === runId;
  }

  private setStage(job: SourceJob, status: PipelineStage, detail: string | undefined) {
    const now = new Date().toISOString();
    job.status = status;
    job.statusDetail = detail;
    job.stageStartedAt = now;
    job.updatedAt = now;
    this.scheduleSync(job);
  }

  /** Progress from inside a long step; the step itself follows the wording. */
  private updateDetail(job: SourceJob, runId: number, detail: string) {
    if (!this.isCurrentRun(job, runId)) return;
    const stage: PipelineStage = /^Listening|^Transcrib/i.test(detail) ? 'analyzing_audio' : 'analyzing_frames';
    this.setStage(job, stage, detail);
  }

  private resetJob(job: SourceJob) {
    job.error = undefined;
    job.candidates = [];
    job.candidateCount = 0;
    job.reviewedCount = 0;
    job.createdAt = new Date().toISOString();
    this.setStage(job, 'added', job.platform === 'google_maps' ? 'Opening the Google Maps link…' : 'Waiting to start…');
  }

  private makeWorkDir(job: SourceJob, runId: number): string {
    const dir = path.join(this.workRoot, `${job.sourceId}-${runId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---- Uploaded videos ---------------------------------------------------------------------

  private storeUpload(sourceId: string, tempFilePath: string, originalName: string): string {
    const ext = (path.extname(originalName) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.mp4';
    const safeId = sourceId.replace(/[^A-Za-z0-9_-]/g, '_');
    const previous = this.findUpload(safeId);
    if (previous) fs.rmSync(previous, { force: true });
    const target = path.join(this.storageDir, `${safeId}${ext}`);
    try {
      fs.renameSync(tempFilePath, target);
    } catch {
      fs.copyFileSync(tempFilePath, target);
      fs.rmSync(tempFilePath, { force: true });
    }
    return target;
  }

  private findUpload(sourceId: string): string | undefined {
    const safeId = sourceId.replace(/[^A-Za-z0-9_-]/g, '_');
    const name = fs.readdirSync(this.storageDir).find(f => path.parse(f).name === safeId);
    return name ? path.join(this.storageDir, name) : undefined;
  }

  private pruneOldUploads() {
    const cutoff = Date.now() - UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(this.storageDir)) {
      const file = path.join(this.storageDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  // ---- Cloud copy (both phones read imports from Supabase) ----------------------------------

  private scheduleSync(job: SourceJob) {
    if (!this.supabase) return;
    clearTimeout(this.syncTimers.get(job.sourceId));
    this.syncTimers.set(
      job.sourceId,
      setTimeout(() => {
        this.syncTimers.delete(job.sourceId);
        void this.syncSource(job);
      }, SYNC_DEBOUNCE_MS)
    );
  }

  private async flushSync(job: SourceJob) {
    if (!this.supabase) return;
    clearTimeout(this.syncTimers.get(job.sourceId));
    this.syncTimers.delete(job.sourceId);
    await this.syncSource(job);
    await this.syncCandidates(job);
  }

  private async syncSource(job: SourceJob): Promise<void> {
    if (!this.supabase) return;
    const row: Record<string, unknown> = {
      id: job.sourceId,
      trip_id: job.tripId,
      platform: job.platform,
      original_url: job.url,
      caption: job.caption || null,
      creator_name: job.creatorName || null,
      thumbnail_url: job.thumbnailUrl || null,
      status: job.status,
      created_at: job.createdAt,
      metadata: {
        candidateCount: job.candidateCount,
        reviewedCount: job.reviewedCount,
        statusDetail: job.statusDetail ?? null,
        error: job.error ?? null,
        durationSeconds: job.durationSeconds ?? null,
        createdBy: job.createdBy ?? null,
        createdByName: job.createdByName ?? null
      }
    };
    if (this.extendedColumns.sources) {
      Object.assign(row, { created_by: job.createdBy ?? null, created_by_name: job.createdByName ?? null, updated_at: job.updatedAt });
    }
    try {
      const { error } = await this.supabase.from('sources').upsert(row, { onConflict: 'id' });
      if (error && this.extendedColumns.sources && isMissingColumn(error)) {
        console.warn('[Supabase Sync Notice] sources is missing the newer columns; run the latest migration.');
        this.extendedColumns.sources = false;
        return this.syncSource(job);
      }
      if (error) console.warn('[Supabase Sync Notice] source upsert:', error.message);
    } catch (err: any) {
      console.warn('[Supabase Sync Notice]', err.message);
    }
  }

  private async syncCandidates(job: SourceJob): Promise<void> {
    if (!this.supabase || job.candidates.length === 0) return;
    // supabase-js reports failures in `error` instead of throwing, so each result is checked.
    const warn = (what: string, error: { message: string } | null) => {
      if (error) console.warn(`[Supabase Sync Notice] ${what}:`, error.message);
    };
    try {
      for (const cand of job.candidates) {
        let placeId: string | null = null;
        if (cand.topMatch) {
          // The id is derived from the Google place id, so the primary key and the
          // (provider, provider_place_id) unique key always agree on which row this is.
          const { data: placeRow, error: placeError } = await this.supabase.from('places').upsert({
            id: `place_${cand.topMatch.providerPlaceId}`,
            provider: 'google',
            provider_place_id: cand.topMatch.providerPlaceId,
            name: cand.topMatch.name,
            formatted_address: cand.topMatch.address || null,
            latitude: cand.topMatch.location.latitude,
            longitude: cand.topMatch.location.longitude,
            category: cand.category
          }, { onConflict: 'id' }).select('id').maybeSingle();
          warn('place upsert', placeError);
          placeId = placeRow?.id || null;
        }

        const row: Record<string, unknown> = {
          id: cand.id,
          source_id: job.sourceId,
          raw_name: cand.rawName,
          category: cand.category.toLowerCase(),
          model_confidence: cand.modelConfidence,
          resolution_confidence: cand.resolutionConfidence,
          review_state: cand.reviewState.toLowerCase(),
          resolved_place_id: placeId,
          evidence: cand.evidence
        };
        if (this.extendedColumns.candidates) {
          Object.assign(row, { options: cand.options, area_hint: cand.areaHint ?? null, tip: cand.tip ?? null });
        }
        let { error } = await this.supabase.from('place_candidates').upsert(row, { onConflict: 'id' });
        if (error && this.extendedColumns.candidates && isMissingColumn(error)) {
          console.warn('[Supabase Sync Notice] place_candidates is missing the newer columns; run the latest migration.');
          this.extendedColumns.candidates = false;
          delete row.options;
          delete row.area_hint;
          delete row.tip;
          ({ error } = await this.supabase.from('place_candidates').upsert(row, { onConflict: 'id' }));
        }
        warn('candidate upsert', error);
      }
    } catch (err: any) {
      console.warn('[Supabase Sync Notice]', err.message);
    }
  }

  private async syncCandidateReview(candidateId: string, state: string) {
    if (!this.supabase) return;
    const { error } = await this.supabase.from('place_candidates').update({ review_state: state.toLowerCase() }).eq('id', candidateId);
    if (error) console.warn('[Supabase Sync Notice] candidate review:', error.message);
  }

  /** Jobs live in memory; imports that were running when the server stopped can't finish. */
  private async markInterruptedSources() {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase.from('sources').select('id, metadata').in('status', ACTIVE_STAGES);
      if (error || !data) return;
      for (const row of data) {
        const metadata = { ...(row.metadata ?? {}), statusDetail: null, error: 'The server restarted while this was being analyzed. Tap Retry.' };
        await this.supabase.from('sources').update({ status: 'failed', metadata }).eq('id', row.id);
      }
      if (data.length > 0) console.log(`[Pipeline] Marked ${data.length} interrupted import(s) as failed.`);
    } catch (err: any) {
      console.warn('[Supabase Sync Notice] interrupted imports:', err.message);
    }
  }
}

/** PostgREST's "column not found" (the database is older than this server). */
function isMissingColumn(error: { code?: string; message: string }): boolean {
  return error.code === 'PGRST204' || error.code === '42703' || /column/i.test(error.message);
}
