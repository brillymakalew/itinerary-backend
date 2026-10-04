import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { loadConfig } from './config';
import { ItinerarySolver, SolverInput } from './itinerary/solver';
import { MediaProcessingPipeline, publicJob } from './media-worker/pipeline';
import { PHOTO_NAME_PATTERN, PlaceMediaService } from './places/placeMediaService';
import { PlaceLookupError, PlaceLookupService } from './places/placeLookup';
import { requireApiToken } from './auth';

const config = loadConfig();
const app = express();
const port = config.port;

app.use(cors());
// Checked before any body parsing or upload handling; /health stays open for uptime checks.
if (config.apiToken) app.use('/api', requireApiToken(config.apiToken));
// Room for a YouTube transcript the phone sends along (a two-hour video is ~500 KB).
app.use(express.json({ limit: '3mb' }));

const solver = new ItinerarySolver();
const placeLookup = new PlaceLookupService(config.googleApiKey);
const pipeline = new MediaProcessingPipeline(config, undefined, placeLookup);
const placeMedia = new PlaceMediaService(config.googleApiKey);

// Multer upload config for video/screenshot fallbacks (PRD §9.2)
const uploadDir = path.resolve(config.dataDir, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.maxUploadBytes }
});

const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/, 'Expected HH:mm');
const Location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const badRequest = (res: express.Response, error: z.ZodError | string) =>
  res.status(400).json({ error: typeof error === 'string' ? error : error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });

// Health Check
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    service: 'Vibi API',
    pipelineVersion: config.pipelineVersion,
    capabilities: {
      placeMedia: placeMedia.isConfigured,
      placeSearch: placeLookup.isConfigured,
      videoDownload: await pipeline.canDownloadVideos()
    }
  });
});

// 18.1 POST /api/sources/import (PRD §18.1) — returns immediately; poll GET /api/sources/:id.
const ImportRequest = z.object({
  trip_id: z.string().min(1),
  url: z.string().min(1).max(2048),
  force: z.boolean().optional(),
  // Caption details the app read on the phone (see SocialAdapters.fromClientPreview).
  preview: z.object({
    title: z.string().max(4000).optional(),
    description: z.string().max(8000).optional(),
    author_name: z.string().max(200).optional(),
    thumbnail_url: z.string().url().max(2048).optional(),
    transcript: z.array(z.object({ start: z.number().min(0), text: z.string().max(2000) })).max(20_000).optional(),
    duration_seconds: z.number().min(0).optional()
  }).optional(),
  // Who added it, so both phones can show "Added by Dian".
  created_by: z.string().max(100).optional(),
  created_by_name: z.string().max(100).optional(),
  // The trip's destination ("Hanoi and Sapa, Vietnam"); place names are matched near it.
  destination: z.string().max(200).optional(),
  // Set when retrying an import; lets an uploaded video be found again after a server restart.
  source_id: z.string().max(100).optional()
});

app.post('/api/sources/import', (req, res) => {
  const parsed = ImportRequest.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Missing trip_id or url');
  const { trip_id, url, force, preview, created_by, created_by_name, destination, source_id } = parsed.data;
  if (!/https?:\/\/\S+/i.test(url) && !url.startsWith('upload://')) {
    return badRequest(res, 'Paste a TikTok, Instagram, YouTube or Google Maps link (it should start with https://).');
  }

  try {
    const job = pipeline.startImportJob(trip_id, url, {
      force: force ?? false,
      preview: preview && {
        title: preview.title,
        description: preview.description,
        authorName: preview.author_name,
        thumbnailUrl: preview.thumbnail_url,
        transcript: preview.transcript,
        durationSeconds: preview.duration_seconds
      },
      createdBy: created_by,
      createdByName: created_by_name,
      destination,
      sourceId: source_id
    });
    return res.status(202).json({
      source_id: job.sourceId,
      trip_id: job.tripId,
      url: job.url,
      platform: job.platform,
      status: job.status,
      status_detail: job.statusDetail
    });
  } catch (err: any) {
    console.error('Import error:', err);
    const gone = /no longer on the server/i.test(err?.message ?? '');
    return res.status(gone ? 410 : 500).json({ error: err.message || 'Import failed' });
  }
});

// GET /api/sources/:id (Check import job status & review candidates)
app.get('/api/sources/:id', (req, res) => {
  const job = pipeline.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Source not found' });
  }
  return res.json(publicJob(job));
});

// GET /api/trips/:tripId/sources (Get all inbox sources for a trip)
app.get('/api/trips/:tripId/sources', (req, res) => {
  return res.json(pipeline.getJobsForTrip(req.params.tripId).map(publicJob));
});

// 18.2 POST /api/sources/:id/upload-fallback — analysis continues in the background.
app.post('/api/sources/:id/upload-fallback', upload.single('media'), (req, res) => {
  const { id } = req.params;
  const tripId = (req.body.trip_id as string) || 'trip_hanoi_sapa_2027';

  if (!req.file) {
    return badRequest(res, 'Missing media file upload');
  }

  const field = (name: string) => {
    const value = req.body?.[name];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
  };
  try {
    const job = pipeline.startMediaUpload(id, tripId, req.file.path, req.file.originalname, {
      createdBy: field('created_by'),
      createdByName: field('created_by_name'),
      destination: field('destination')
    });
    return res.status(202).json(publicJob(job));
  } catch (err: any) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: err.message || 'Media processing failed' });
  }
});

// POST /api/candidates/:id/review (Approve / Save / Maybe / Skip candidate)
app.post('/api/candidates/:id/review', (req, res) => {
  const { id } = req.params;
  const { state } = req.body;
  if (!state) {
    return badRequest(res, 'Missing review state');
  }
  const updated = pipeline.updateCandidateReview(id, state);
  return res.json({ success: updated, candidate_id: id, state });
});

// GET /api/places/search — find a place by name to add it (Plan → Add a stop, Saves → Add).
const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  city: z.string().max(100).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional()
});

app.get('/api/places/search', async (req, res) => {
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) return badRequest(res, 'Missing search query q');
  const { q, city, lat, lng } = parsed.data;
  const near = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined;
  try {
    // Without coordinates the city in the text keeps results in the right country.
    const places = await placeLookup.search(near || !city ? q : `${q} ${city}`, near);
    return res.json({
      results: places.map(p => ({
        providerPlaceId: p.providerPlaceId,
        name: p.name,
        address: p.address,
        latitude: p.location.latitude,
        longitude: p.location.longitude,
        rating: p.rating,
        userRatingCount: p.userRatingCount,
        priceLevel: p.priceLevel,
        types: p.types,
        category: p.category,
        googleMapsUri: p.googleMapsUri
      }))
    });
  } catch (err: any) {
    if (err instanceof PlaceLookupError) return res.status(err.status).json({ error: err.message });
    console.warn('[Places] search failed:', err.message);
    return res.status(502).json({ error: 'Google Maps search is unavailable right now.' });
  }
});

// POST /api/places/resolve-link — the place behind a Google Maps link or share text.
const ResolveLinkRequest = z.object({ text: z.string().trim().min(1).max(4000) });

app.post('/api/places/resolve-link', async (req, res) => {
  const parsed = ResolveLinkRequest.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Paste a Google Maps link.');
  try {
    const place = await placeLookup.resolveMapsLink(parsed.data.text);
    return res.json({ place });
  } catch (err: any) {
    if (err instanceof PlaceLookupError) return res.status(err.status).json({ error: err.message });
    console.warn('[Places] link lookup failed:', err.message);
    return res.status(502).json({ error: 'Couldn’t open that Google Maps link right now. Try again.' });
  }
});

// GET /api/places/media — photos, rating, hours and website for a place (PRD §9.6).
const MediaQuery = z.object({
  name: z.string().min(1).max(300),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  placeId: z.string().max(300).optional()
});

app.get('/api/places/media', async (req, res) => {
  const parsed = MediaQuery.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  if (!placeMedia.isConfigured) {
    return res.status(503).json({ error: 'Place photos need GOOGLE_PLACES_API_KEY on the server.' });
  }
  const { name, lat, lng, placeId } = parsed.data;
  try {
    const media = await placeMedia.getMedia({
      name,
      placeId,
      location: lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined
    });
    if (!media) return res.status(404).json({ error: 'No matching place found on Google Maps.' });
    res.set('Cache-Control', 'private, max-age=3600');
    return res.json(media);
  } catch (err: any) {
    console.warn('[Places] media lookup failed:', err.message);
    return res.status(502).json({ error: 'Google Maps is unavailable right now.' });
  }
});

// GET /api/places/photo — redirects to the image so the API key never reaches the client.
app.get('/api/places/photo', async (req, res) => {
  const name = String(req.query.name ?? '');
  if (!PHOTO_NAME_PATTERN.test(name)) return badRequest(res, 'Invalid photo name');
  const maxWidth = Math.min(1600, Math.max(100, Number(req.query.maxWidth) || 800));
  try {
    const uri = await placeMedia.resolvePhotoUri(name, maxWidth);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.redirect(302, uri);
  } catch (err: any) {
    console.warn('[Places] photo lookup failed:', err.message);
    return res.status(502).json({ error: 'Photo unavailable' });
  }
});

// 18.5 POST /api/trip-days/:id/optimize (PRD §18.5)
const OptimizeRequest = z.object({
  expected_day_version: z.number().optional(),
  start_time: HHMM.optional(),
  preferred_end_time: HHMM.nullish(),
  travel_mode: z.enum(['WALK', 'DRIVE', 'TWO_WHEELER', 'TRANSIT']).optional(),
  start_location: Location.nullish(),
  items: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    dwell_minutes: z.number().int().positive().max(24 * 60),
    location: Location.nullish(),
    fixed_start: HHMM.nullish(),
    window_start: HHMM.nullish(),
    window_end: HHMM.nullish(),
    opening_hours: z.array(z.object({ open: HHMM, close: HHMM })).optional()
  })).min(1).max(30),
  constraints: z.array(z.object({
    id: z.string(),
    type: z.enum(['MUST_BE_BEFORE', 'MUST_BE_AFTER']),
    source_item_id: z.string(),
    target_item_id: z.string(),
    is_hard: z.boolean()
  })).optional()
});

app.post('/api/trip-days/:id/optimize', (req, res) => {
  const parsed = OptimizeRequest.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const body = parsed.data;

  const input: SolverInput = {
    dayId: req.params.id,
    dayStartMinutes: toMinutes(body.start_time ?? '09:00'),
    dayPreferredEndMinutes: body.preferred_end_time ? toMinutes(body.preferred_end_time) : undefined,
    startLocation: body.start_location ?? undefined,
    travelMode: body.travel_mode ?? 'WALK',
    items: body.items.map(item => ({
      id: item.id,
      title: item.title,
      dwellMinutes: item.dwell_minutes,
      location: item.location ?? undefined,
      fixedStartMinutes: item.fixed_start ? toMinutes(item.fixed_start) : undefined,
      windowStartMinutes: item.window_start ? toMinutes(item.window_start) : undefined,
      windowEndMinutes: item.window_end ? toMinutes(item.window_end) : undefined,
      openingHours: item.opening_hours?.map(h => {
        const open = toMinutes(h.open);
        const close = toMinutes(h.close);
        return { openMinutes: open, closeMinutes: close <= open ? close + 24 * 60 : close };
      })
    })),
    constraints: (body.constraints ?? []).map(c => ({
      id: c.id,
      type: c.type,
      sourceItemId: c.source_item_id,
      targetItemId: c.target_item_id,
      isHard: c.is_hard
    }))
  };

  const result = solver.solve(input);
  if (!result.success) {
    return res.status(422).json({ error: result.error });
  }

  return res.json({
    proposal_id: `prop_${Date.now()}`,
    source_day_version: body.expected_day_version ?? 1,
    ordered_item_ids: result.orderedItemIds,
    unchanged: result.unchanged,
    schedule: result.schedule.map(s => ({
      id: s.id,
      planned_start: s.plannedStartFormatted,
      planned_end: s.plannedEndFormatted,
      dwell_minutes: s.dwellMinutes
    })),
    legs: result.legs.map(l => ({
      from_id: l.fromId,
      to_id: l.toId,
      duration_minutes: l.travelMinutes,
      distance_meters: l.distanceMeters,
      mode: l.mode
    })),
    warnings: result.warnings,
    summary: {
      travel_minutes_before: result.travelMinutesBefore,
      travel_minutes_after: result.travelMinutesAfter,
      estimated_end: result.schedule[result.schedule.length - 1]?.plannedEndFormatted ?? body.start_time ?? '09:00'
    }
  });
});

app.listen(port, () => {
  console.log(`Vibi API listening on port ${port} (API token ${config.apiToken ? 'required' : 'not required'})`);
});
