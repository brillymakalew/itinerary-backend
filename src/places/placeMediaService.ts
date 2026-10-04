// Place photos & live details via Google Places API (New). The API key stays on the server:
// the app receives photo *names* and loads bytes through GET /api/places/photo.

import { distanceMeters, LatLng } from '../itinerary/travel';

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
}

const PLACES_API = 'https://places.googleapis.com/v1';
/** Matches the app's language, and keeps weekdayDescriptions as predictable "Monday: …" lines. */
const RESULT_LANGUAGE = 'en';
const DETAIL_FIELDS = 'id,photos,rating,userRatingCount,googleMapsUri,websiteUri,regularOpeningHours.weekdayDescriptions';
const SEARCH_FIELDS = DETAIL_FIELDS.split(',').map(f => `places.${f}`).concat('places.location').join(',');
const MAX_PHOTOS = 8;
/** A text-search hit farther than this from the saved coordinates is probably a different place. */
const MAX_MATCH_DISTANCE_METERS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_RESULT_COUNT = 5;

/** `places/{placeId}/photos/{photoId}`; anything else is rejected before reaching Google. */
export const PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

class TtlCache<V> {
  private entries = new Map<string, { expiresAt: number; value: V }>();
  constructor(private ttlMs: number, private maxEntries: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number = this.ttlMs) {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { expiresAt: Date.now() + ttlMs, value });
  }
}

export class PlaceMediaService {
  // Short-lived caches keep repeat views cheap without storing provider content long-term.
  private mediaCache = new TtlCache<PlaceMedia | null>(60 * 60 * 1000, 500);
  private photoUriCache = new TtlCache<string>(60 * 60 * 1000, 2000);
  private inflight = new Map<string, Promise<PlaceMedia | null>>();

  constructor(private apiKey: string) {}

  get isConfigured(): boolean {
    return Boolean(this.apiKey) && !this.apiKey.includes('your-google-places');
  }

  async getMedia(query: PlaceMediaQuery): Promise<PlaceMedia | null> {
    // The answer depends on every input (an invalid id falls back to a name search).
    const key = [
      query.placeId ?? '',
      query.name.trim().toLowerCase(),
      query.location?.latitude.toFixed(4) ?? '',
      query.location?.longitude.toFixed(4) ?? ''
    ].join('|');
    const cached = this.mediaCache.get(key);
    if (cached !== undefined) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchMedia(query).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const media = await pending;
    // Misses are cached briefly so a later fix (or new Google data) shows up soon.
    this.mediaCache.set(key, media, media ? undefined : NEGATIVE_CACHE_TTL_MS);
    return media;
  }

  /** Resolves a photo name to a short-lived public image URL (the key never leaves the server). */
  async resolvePhotoUri(photoName: string, maxWidthPx: number): Promise<string> {
    const key = `${photoName}@${maxWidthPx}`;
    const cached = this.photoUriCache.get(key);
    if (cached) return cached;

    const res = await fetch(`${PLACES_API}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`, {
      headers: { 'X-Goog-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Photo lookup failed (HTTP ${res.status})`);
    const body = (await res.json()) as { photoUri?: string };
    if (!body.photoUri) throw new Error('Photo lookup returned no image');
    this.photoUriCache.set(key, body.photoUri);
    return body.photoUri;
  }

  private async fetchMedia(query: PlaceMediaQuery): Promise<PlaceMedia | null> {
    // Saved ids can be stale or placeholders (demo data); fall back to a location-biased search.
    if (query.placeId) {
      const byId = await this.fetchDetails(query.placeId).catch(() => null);
      if (byId) return byId;
    }
    return this.searchByText(query);
  }

  private async fetchDetails(placeId: string): Promise<PlaceMedia | null> {
    const res = await fetch(`${PLACES_API}/places/${encodeURIComponent(placeId)}?languageCode=${RESULT_LANGUAGE}`, {
      headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': DETAIL_FIELDS },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
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
    const res = await fetch(`${PLACES_API}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': SEARCH_FIELDS
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
}
