// End-to-End Media Processing Pipeline (PRD §9.3 & §9.4 & Appendix A)

import fs from 'fs';
import path from 'path';
import { SocialAdapters, SocialMetadata } from './adapters/socialAdapters';
import { ExtractionResult, OpenAiExtractor } from './openaiExtractor';
import { GooglePlacesResolver, ResolvedCandidate } from './googlePlacesResolver';
import { AppConfig } from '../config';
import { getSupabaseClient } from '../supabase';
import { SupabaseClient } from '@supabase/supabase-js';

export type PipelineStage =
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

const ACTIVE_STAGES: PipelineStage[] = ['added', 'fetching_metadata', 'analyzing_audio', 'analyzing_frames', 'resolving_places'];

/** Hard ceilings so a job always ends in a visible state instead of hanging. */
const LINK_JOB_TIMEOUT_MS = 120_000;
const UPLOAD_JOB_TIMEOUT_MS = 300_000;
/** Most posts mention a handful of places; resolving more only adds latency and cost. */
const MAX_PLACES_PER_SOURCE = 8;

export interface SourceJob {
  sourceId: string;
  tripId: string;
  url: string;
  platform: 'tiktok' | 'instagram' | 'other_url';
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

export class MediaProcessingPipeline {
  private extractor: OpenAiExtractor;
  private placesResolver: GooglePlacesResolver;
  private jobs: Map<string, SourceJob> = new Map();
  /** Incremented per (re)run so results from an abandoned (timed-out) run are ignored. */
  private runIds: Map<string, number> = new Map();
  private storageDir: string;
  private supabase: SupabaseClient | null;

  constructor(config: AppConfig) {
    this.extractor = new OpenAiExtractor(config.openaiApiKey, config.visionModel, config.transcriptionModel);
    this.placesResolver = new GooglePlacesResolver(config.googleApiKey);
    this.supabase = getSupabaseClient(config);
    this.storageDir = path.resolve(config.dataDir, 'uploads');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Stage 1-7: Process URL Import Asynchronously (PRD §9.3 & §18.1).
   * The same link for the same trip reuses its job; a finished or failed job only re-runs
   * when [force] is set (the app's Retry), and a running job is never started twice.
   */
  startImportJob(tripId: string, rawUrl: string, force = false): SourceJob {
    const { normalizedUrl, platform } = SocialAdapters.normalizeUrl(rawUrl);

    const existing = [...this.jobs.values()].find(j => j.tripId === tripId && j.url === normalizedUrl);
    if (existing) {
      const running = ACTIVE_STAGES.includes(existing.status);
      if (running || (!force && existing.status !== 'failed')) return existing;
      this.resetJob(existing);
      this.runLinkJob(existing);
      return existing;
    }

    const now = new Date().toISOString();
    const job: SourceJob = {
      sourceId: `src_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tripId,
      url: normalizedUrl,
      platform,
      status: 'fetching_metadata',
      statusDetail: "Reading the post's caption and thumbnail…",
      candidateCount: 0,
      reviewedCount: 0,
      candidates: [],
      createdAt: now,
      updatedAt: now,
      stageStartedAt: now
    };
    this.jobs.set(job.sourceId, job);
    this.runLinkJob(job);
    return job;
  }

  /**
   * Accepts a user-provided video for a source (PRD §9.2 & §18.2) and analyzes it in the
   * background; callers poll GET /api/sources/:id like a link import.
   */
  startMediaUpload(sourceId: string, tripId: string, filePath: string, originalName: string): SourceJob {
    let job = this.jobs.get(sourceId);
    if (!job) {
      const now = new Date().toISOString();
      job = {
        sourceId,
        tripId,
        url: `upload://${originalName}`,
        platform: 'other_url',
        status: 'analyzing_audio',
        candidateCount: 0,
        reviewedCount: 0,
        candidates: [],
        createdAt: now,
        updatedAt: now,
        stageStartedAt: now
      };
      this.jobs.set(sourceId, job);
    } else if (ACTIVE_STAGES.includes(job.status) && job.status !== 'analyzing_audio') {
      fs.promises.unlink(filePath).catch(() => {});
      return job;
    } else {
      this.resetJob(job);
    }
    const runId = this.beginRun(job);
    this.setStage(job, 'analyzing_audio', 'Transcribing speech and sampling frames…');

    const meta: SocialMetadata = {
      platform: job.platform,
      originalUrl: job.url,
      normalizedUrl: job.url,
      caption: job.caption || originalName,
      hasAnalyzableMedia: true
    };
    const target = job;
    const work = (async () => {
      const extracted = await this.extractor.extractFromUploadedMedia(filePath, meta, this.storageDir);
      if (!this.isCurrentRun(target, runId)) return;
      if (extracted.source_summary) target.caption = target.caption || extracted.source_summary;
      await this.resolveAndFinish(target, runId, extracted, 'needs_user_correction');
    })();
    this.supervise(target, runId, work, UPLOAD_JOB_TIMEOUT_MS).finally(() => {
      fs.promises.unlink(filePath).catch(() => {});
    });
    return job;
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
        this.syncJobToSupabase(job).catch(() => {});
        return true;
      }
    }
    return false;
  }

  private runLinkJob(job: SourceJob) {
    const runId = this.beginRun(job);
    const work = (async () => {
      // Stage 2: official metadata (oEmbed / public tags).
      const meta = await SocialAdapters.fetchMetadata(job.url, job.platform);
      if (!this.isCurrentRun(job, runId)) return;
      job.creatorName = meta.authorName;
      job.caption = meta.caption || meta.title;
      job.thumbnailUrl = meta.thumbnailUrl;

      // Nothing readable (private, removed or blocked post): asking the AI would only invite
      // invented places, so go straight to the video-upload fallback.
      if (meta.hasMetadata === false) {
        if (job.platform === 'other_url') {
          // A web page has no video to upload; the only useful next step is checking the link.
          job.error = "Couldn't read this page (it may be private, removed, or blocking apps). Check the link and try again.";
          this.setStage(job, 'failed', undefined);
        } else {
          this.setStage(job, 'needs_media', "Couldn't read this post (it may be private or removed). Upload the video so speech and signs can be analyzed.");
        }
        await this.syncJobToSupabase(job);
        return;
      }

      // Stage 6: multimodal extraction from caption + thumbnail.
      this.setStage(job, 'analyzing_frames', 'Asking AI to spot places in the caption and thumbnail…');
      const extraction = await this.extractor.extractFromMetadata(meta);
      if (!this.isCurrentRun(job, runId)) return;

      // Stage 7: resolve on the map. No places in a social post → ask for the video (PRD §6.1);
      // a web page has no video, so it simply needs the user's attention.
      await this.resolveAndFinish(job, runId, extraction, job.platform === 'other_url' ? 'needs_user_correction' : 'needs_media');
    })();
    this.supervise(job, runId, work, LINK_JOB_TIMEOUT_MS);
  }

  private async resolveAndFinish(job: SourceJob, runId: number, extraction: ExtractionResult, whenEmpty: PipelineStage) {
    const places = extraction.places.slice(0, MAX_PLACES_PER_SOURCE);
    if (places.length > 0) {
      this.setStage(job, 'resolving_places', `Matching ${plural(places.length, 'place')} on Google Maps…`);
    }
    // Resolve in parallel: each lookup is an independent network call.
    const resolved = await Promise.all(places.map(place => this.placesResolver.resolve(place, job.sourceId)));
    if (!this.isCurrentRun(job, runId)) return;

    job.candidates = resolved;
    job.candidateCount = resolved.length;
    if (resolved.length > 0) {
      this.setStage(job, 'ready_to_review', `Found ${plural(resolved.length, 'place')}`);
    } else if (whenEmpty === 'needs_media') {
      this.setStage(job, 'needs_media', 'No places in the caption. Upload the video so speech and signs can be analyzed.');
    } else {
      const detail = job.url.startsWith('upload://') ? 'No places detected in this video.' : 'No specific places found on this page.';
      this.setStage(job, whenEmpty, detail);
    }
    await this.syncJobToSupabase(job);
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
      this.syncJobToSupabase(job).catch(() => {});
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
  }

  private resetJob(job: SourceJob) {
    job.error = undefined;
    job.candidates = [];
    job.candidateCount = 0;
    job.reviewedCount = 0;
    job.createdAt = new Date().toISOString();
    this.setStage(job, 'fetching_metadata', "Reading the post's caption and thumbnail…");
  }

  private async syncJobToSupabase(job: SourceJob): Promise<void> {
    if (!this.supabase) return;
    // supabase-js reports failures in `error` instead of throwing, so each result is checked.
    const warn = (what: string, error: { message: string } | null) => {
      if (error) console.warn(`[Supabase Sync Notice] ${what}:`, error.message);
    };
    try {
      const { error: sourceError } = await this.supabase.from('sources').upsert({
        id: job.sourceId,
        trip_id: job.tripId,
        platform: job.platform,
        original_url: job.url,
        caption: job.caption || null,
        creator_name: job.creatorName || null,
        thumbnail_url: job.thumbnailUrl || null,
        status: job.status,
        metadata: { candidateCount: job.candidateCount, statusDetail: job.statusDetail ?? null, error: job.error ?? null }
      }, { onConflict: 'id' });
      warn('source upsert', sourceError);

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

        const { error: candidateError } = await this.supabase.from('place_candidates').upsert({
          id: cand.id,
          source_id: job.sourceId,
          raw_name: cand.rawName,
          category: cand.category.toLowerCase(),
          model_confidence: cand.modelConfidence,
          resolution_confidence: cand.resolutionConfidence,
          review_state: cand.reviewState.toLowerCase(),
          resolved_place_id: placeId,
          evidence: cand.evidence
        }, { onConflict: 'id' });
        warn('candidate upsert', candidateError);
      }
    } catch (err: any) {
      console.warn('[Supabase Sync Notice]', err.message);
    }
  }
}
