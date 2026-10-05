// Place photos & live details via Google Places API (New). The API key stays on the server:
// the app receives photo *names* and loads the images through GET /api/places/photo.
//
// Free-tier notes: a photo list (field mask `id,photos`) is an "IDs only" request with no charge;
// ratings, hours and websites bill the Enterprise SKU (1,000 free calls a month), so they are only
// fetched for the place screen. Images are kept on disk so each one is fetched from Google once.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { distanceMeters, LatLng } from '../itinerary/travel';
import { GoogleSku, UsageLimitError, UsageMeter } from '../usage/usageMeter';
import { JsonFileCache } from './fileCache';

export interface PlacePhotoInfo {
  name: string;
  widthPx?: number;
  heightPx?: number;
  attributions: { displayName: string; uri?: string }[];
}

export interface PlaceMedia {
  providerPlaceId: string;
  photos: PlacePhotoInfo[];
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  websiteUri?: string;
  weekdayHours: string[];
}

export interface PlaceMediaQuery {
  name: string;
  location?: LatLng;
  placeId?: string;
  /** Ratings, hours and website too (the place screen); lists only need photos. */
  detail?: boolean;
}

export interface PlacePhoto {
  bytes: Buffer;
  contentType: string;
}

export interface PlaceMediaOptions {
  /** Where details and images are cached between restarts; memory only when omitted. */
  cacheDir?: string;
}

const PLACES_API = 'https://places.googleapis.com/v1';
/** Matches the app's language, and keeps weekdayDescriptions as predictable "Monday: …" lines. */
const RESULT_LANGUAGE = 'en';
const PHOTO_FIELDS = 'id,photos';
const DETAIL_FIELDS = 'id,photos,rating,userRatingCount,googleMapsUri,websiteUri,regularOpeningHours.weekdayDescriptions';
const searchFields = (fields: string) => fields.split(',').map(f => `places.${f}`).concat('places.location').join(',');
const MAX_PHOTOS = 8;
/** A text-search hit farther than this from the saved coordinates is probably a different place. */
const MAX_MATCH_DISTANCE_METERS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_RESULT_COUNT = 5;
const PHOTO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PHOTO_CACHE_MAX_BYTES = 300 * 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** `places/{placeId}/photos/{photoId}`; anything else is rejected before reaching Google. */
export const PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/** A Google photo that no longer exists (photo names expire); the app shows a placeholder. */
export class PhotoGoneError extends Error {}

export class PlaceMediaService {
  private mediaCache: JsonFileCache<PlaceMedia>;
  /** Misses are remembered briefly (memory only) so a later fix on Google shows up soon. */
  private misses = new Map<string, number>();
  private inflight = new Map<string, Promise<PlaceMedia | null>>();
  private photoInflight = new Map<string, Promise<PlacePhoto>>();
  private photoDir?: string;
  private photoWrites = 0;

  constructor(private apiKey: string, private meter?: UsageMeter, options: PlaceMediaOptions = {}) {
    const cacheDir = options.cacheDir;
    this.mediaCache = new JsonFileCache<PlaceMedia>(cacheDir && path.join(cacheDir, 'place-media.json'), MEDIA_CACHE_TTL_MS, 5_000);
    if (cacheDir) {
      this.photoDir = path.join(cacheDir, 'photos');
      fs.mkdirSync(this.photoDir, { recursive: true });
      this.prunePhotos();
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey) && !this.apiKey.includes('your-google-places');
  }

  async getMedia(query: PlaceMediaQuery): Promise<PlaceMedia | null> {
    // The answer depends on every input (an invalid id falls back to a name search).
    const key = [
      query.detail ? 'detail' : 'photos',
      query.placeId ?? '',
      query.name.trim().toLowerCase(),
      query.location?.latitude.toFixed(4) ?? '',
      query.location?.longitude.toFixed(4) ?? ''
    ].join('|');
    const cached = this.mediaCache.get(key);
    if (cached) return cached;
    // The place screen's details include the photos, so a list can reuse them.
    if (!query.detail) {
      const detailed = this.mediaCache.get(key.replace(/^photos\|/, 'detail|'));
      if (detailed) return detailed;
    }
    const missAt = this.misses.get(key);
    if (missAt && Date.now() - missAt < NEGATIVE_CACHE_TTL_MS) return null;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchMedia(query).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const media = await pending;
    if (media) {
      this.mediaCache.set(key, media);
      this.misses.delete(key);
    } else {
      if (this.misses.size > 2_000) this.misses.clear();
      this.misses.set(key, Date.now());
    }
    return media;
  }

  /** The image bytes for a photo name, from the disk cache or Google. */
  async getPhoto(photoName: string, maxWidthPx: number): Promise<PlacePhoto> {
    const key = `${photoName}@${maxWidthPx}`;
    const cached = this.readCachedPhoto(key);
    if (cached) return cached;
    let pending = this.photoInflight.get(key);
    if (!pending) {
      pending = this.downloadPhoto(photoName, maxWidthPx)
        .then(photo => {
          this.writeCachedPhoto(key, photo);
          return photo;
        })
        .finally(() => this.photoInflight.delete(key));
      this.photoInflight.set(key, pending);
    }
    return pending;
  }

  private async downloadPhoto(photoName: string, maxWidthPx: number): Promise<PlacePhoto> {
    const res = await this.google('place_photos', `${PLACES_API}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`, {
      headers: { 'X-Goog-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (res.status === 400 || res.status === 404) throw new PhotoGoneError(`Photo no longer available (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`Photo lookup failed (HTTP ${res.status})`);
    const body = (await res.json()) as { photoUri?: string };
    if (!body.photoUri) throw new Error('Photo lookup returned no image');
    // The image itself comes from Google's content servers and isn't billed again.
    const image = await fetch(body.photoUri, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!image.ok) throw new Error(`Photo download failed (HTTP ${image.status})`);
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES) throw new Error('Photo is unexpectedly large');
    return { bytes, contentType: image.headers.get('content-type')?.split(';')[0] || 'image/jpeg' };
  }

  private async fetchMedia(query: PlaceMediaQuery): Promise<PlaceMedia | null> {
    // Saved ids can be stale or placeholders (demo data); fall back to a location-biased search.
    if (query.placeId) {
      const byId = await this.fetchDetails(query.placeId, Boolean(query.detail)).catch(err => {
        if (err instanceof UsageLimitError) throw err;
        return null;
      });
      if (byId) return byId;
    }
    return this.searchByText(query);
  }

  private async fetchDetails(placeId: string, detail: boolean): Promise<PlaceMedia | null> {
    const res = await this.google(
      detail ? 'place_details_enterprise' : 'place_details_ids',
      `${PLACES_API}/places/${encodeURIComponent(placeId)}?languageCode=${RESULT_LANGUAGE}`,
      {
        headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': detail ? DETAIL_FIELDS : PHOTO_FIELDS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Place details failed (HTTP ${res.status})`);
    return this.toMedia(await res.json());
  }

  private async searchByText(query: PlaceMediaQuery): Promise<PlaceMedia | null> {
    const body: Record<string, unknown> = {
      textQuery: query.name,
      maxResultCount: SEARCH_RESULT_COUNT,
      languageCode: RESULT_LANGUAGE
    };
    if (query.location) {
      body.locationBias = { circle: { center: query.location, radius: 3000 } };
    }
    const res = await this.google(query.detail ? 'text_search_enterprise' : 'text_search_pro', `${PLACES_API}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': searchFields(query.detail ? DETAIL_FIELDS : PHOTO_FIELDS)
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status})`);
    const data = (await res.json()) as { places?: any[] };
    const nearby = (data.places ?? []).filter(p =>
      !query.location || !p.location || distanceMeters(query.location, p.location) <= MAX_MATCH_DISTANCE_METERS
    );
    // Results are relevance-ranked; prefer the best one that actually has photos (a street or
    // area often ranks first but has none).
    const best = nearby.find(p => (p.photos?.length ?? 0) > 0) ?? nearby[0];
    return best ? this.toMedia(best) : null;
  }

  private google(sku: GoogleSku, url: string, init: RequestInit): Promise<Response> {
    return this.meter ? this.meter.fetchGoogle(sku, url, init) : fetch(url, init);
  }

  private toMedia(place: any): PlaceMedia {
    return {
      providerPlaceId: place.id,
      photos: (place.photos ?? []).slice(0, MAX_PHOTOS).map((p: any) => ({
        name: p.name,
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        attributions: (p.authorAttributions ?? []).map((a: any) => ({ displayName: a.displayName, uri: a.uri }))
      })),
      rating: place.rating,
      userRatingCount: place.userRatingCount,
      googleMapsUri: place.googleMapsUri,
      websiteUri: place.websiteUri,
      weekdayHours: place.regularOpeningHours?.weekdayDescriptions ?? []
    };
  }

  // ---- Image cache on disk ---------------------------------------------------------------

  private photoFileBase(key: string): string | undefined {
    if (!this.photoDir) return undefined;
    return path.join(this.photoDir, crypto.createHash('sha1').update(key).digest('hex'));
  }

  private readCachedPhoto(key: string): PlacePhoto | null {
    const base = this.photoFileBase(key);
    if (!base) return null;
    for (const [ext, contentType] of Object.entries(CONTENT_TYPES)) {
      const file = base + ext;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > PHOTO_CACHE_TTL_MS) {
          fs.rmSync(file, { force: true });
          return null;
        }
        return { bytes: fs.readFileSync(file), contentType };
      } catch {
        // Not cached with this extension.
      }
    }
    return null;
  }

  private writeCachedPhoto(key: string, photo: PlacePhoto) {
    const base = this.photoFileBase(key);
    if (!base) return;
    const ext = Object.entries(CONTENT_TYPES).find(([, type]) => type === photo.contentType)?.[0] ?? '.jpg';
    try {
      fs.writeFileSync(base + ext, photo.bytes);
      if (++this.photoWrites % 50 === 0) this.prunePhotos();
    } catch (err: any) {
      console.warn('[Places] Could not cache a photo:', err?.message ?? err);
    }
  }

  /** Drops expired images, then the oldest ones while the cache is over its size cap. */
  private prunePhotos() {
    if (!this.photoDir) return;
    try {
      const files = fs.readdirSync(this.photoDir).map(name => {
        const file = path.join(this.photoDir!, name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, mtimeMs: stat.mtimeMs };
      });
      let total = 0;
      const now = Date.now();
      for (const entry of files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        total += entry.size;
        if (now - entry.mtimeMs > PHOTO_CACHE_TTL_MS || total > PHOTO_CACHE_MAX_BYTES) fs.rmSync(entry.file, { force: true });
      }
    } catch (err: any) {
      console.warn('[Places] Could not prune the photo cache:', err?.message ?? err);
    }
  }
}
