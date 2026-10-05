// Google Places Resolver (PRD §6.3, §9.3 Stage 7 & §15.2)

import { ExtractedPlace } from './openaiExtractor';
import { JsonFileCache } from '../places/fileCache';
import { UsageLimitError, UsageMeter } from '../usage/usageMeter';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
/**
 * Pro fields only: enough to put a candidate on the map. Asking for ratings or price levels
 * would bill the Enterprise SKU, which has a fifth of the free calls.
 */
const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType';
const MAX_MATCHES = 4;
const REQUEST_TIMEOUT_MS = 8_000;
/** Videos about the same city keep naming the same places; their matches are reused for a month. */
export const RESOLUTION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProviderMatch {
  providerPlaceId: string;
  name: string;
  address?: string;
  location: { latitude: number; longitude: number };
  types: string[];
}

export interface ResolvedCandidate {
  id: string;
  sourceId: string;
  rawName: string;
  category: string;
  areaHint?: string;
  modelConfidence: number;
  resolutionConfidence: number;
  confidenceBand: 'HIGH' | 'CHECK' | 'LOW';
  reviewState: 'PENDING' | 'SAVED' | 'MAYBE' | 'SKIPPED' | 'WRONG_PLACE';
  /** Practical advice the source gives about the place, shown as a tip once it's saved. */
  tip?: string;
  evidence: {
    type: string;
    text?: string;
    startSeconds?: number;
    endSeconds?: number;
    frameSeconds?: number;
    chipLabel: string;
  }[];
  topMatch?: {
    providerPlaceId: string;
    name: string;
    address?: string;
    location: { latitude: number; longitude: number };
    rating?: number;
    priceLevel?: number;
    category: string;
    /** Google place types, e.g. ["locality", "political"] for a whole city. */
    types?: string[];
  };
  options: {
    providerPlaceId: string;
    name: string;
    address?: string;
    location?: { latitude: number; longitude: number };
    confidence: number;
  }[];
}

export class GooglePlacesResolver {
  constructor(
    private readonly apiKey: string,
    private readonly meter?: UsageMeter,
    private readonly cache?: JsonFileCache<ProviderMatch[]>
  ) {}

  /**
   * Resolve an extracted candidate against Google Places API (PRD §9.3 Stage 7)
   */
  async resolve(candidate: ExtractedPlace, sourceId: string, destination = 'Hanoi, Vietnam'): Promise<ResolvedCandidate> {
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    // The area the source mentions is the best hint; otherwise search around the trip destination.
    const area = candidate.city_or_area_hint
      ? `${candidate.city_or_area_hint} ${candidate.country_hint || ''}`.trim()
      : destination;
    const query = `${candidate.raw_name} ${area}`;

    let providerMatches: ProviderMatch[] = [];

    if (this.apiKey && !this.apiKey.includes('your-google-places')) {
      try {
        providerMatches = await this.search(query);
      } catch (err) {
        // At the free-tier limit the whole import stops with that reason instead of saving
        // places that can never be matched.
        if (err instanceof UsageLimitError) throw err;
        console.warn(`[GooglePlacesResolver] Text search error for "${query}":`, (err as any)?.message ?? err);
      }
    }

    // No map match: keep the candidate (the user can still review it) but never invent a location.
    // Calculate confidence for each option
    const scoredOptions = providerMatches.map(match => {
      const sim = this.calculateSimilarity(candidate.raw_name, match.name);
      return {
        providerPlaceId: match.providerPlaceId,
        name: match.name,
        address: match.address,
        location: match.location,
        confidence: Math.round(sim * 100) / 100
      };
    });

    const topMatch = providerMatches[0];
    const topConfidence = scoredOptions[0]?.confidence ?? Math.min(candidate.model_confidence || 0.5, 0.5);

    // Thresholds per PRD §9.3 Stage 7: >= 0.90 HIGH, 0.70-0.89 CHECK, < 0.70 LOW
    const band: 'HIGH' | 'CHECK' | 'LOW' =
      topConfidence >= 0.90 ? 'HIGH' : topConfidence >= 0.70 ? 'CHECK' : 'LOW';

    // Format evidence with chip labels matching PRD §13.3
    const formattedEvidence = candidate.evidence.map(ev => {
      const at = ev.frame_seconds ?? ev.start_seconds;
      let atStr = '';
      if (at !== undefined && at !== null) {
        const total = Math.floor(at);
        const mins = Math.floor(total / 60);
        const secs = (total % 60).toString().padStart(2, '0');
        atStr = ` at ${mins}:${secs}`;
      }

      let chipLabel = 'caption';
      if (ev.type === 'speech') chipLabel = `spoken${atStr}`;
      else if (ev.type === 'onscreen_text') chipLabel = `sign visible${atStr}`;
      else if (ev.type === 'visual_landmark') chipLabel = `landmark${atStr}`;
      else if (ev.type === 'location_tag') chipLabel = 'location tag';

      return {
        type: ev.type,
        text: ev.text,
        startSeconds: ev.start_seconds,
        endSeconds: ev.end_seconds,
        frameSeconds: ev.frame_seconds,
        chipLabel
      };
    });

    return {
      id: candidateId,
      sourceId,
      rawName: candidate.raw_name,
      category: this.mapCategory(candidate.place_type),
      areaHint: candidate.city_or_area_hint,
      modelConfidence: candidate.model_confidence,
      resolutionConfidence: topConfidence,
      confidenceBand: band,
      reviewState: 'PENDING',
      tip: candidate.tip || undefined,
      evidence: formattedEvidence,
      topMatch: topMatch
        ? {
            providerPlaceId: topMatch.providerPlaceId,
            name: topMatch.name,
            address: topMatch.address,
            location: topMatch.location,
            category: this.mapCategory(candidate.place_type),
            types: topMatch.types
          }
        : undefined,
      options: scoredOptions
    };
  }

  /** Places API (New) text search, answered from the cache when the same query was seen lately. */
  private async search(query: string): Promise<ProviderMatch[]> {
    const key = this.fold(query).replace(/\s+/g, ' ').trim();
    const cached = this.cache?.get(key);
    if (cached) return cached;

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': SEARCH_FIELD_MASK },
      body: JSON.stringify({ textQuery: query, maxResultCount: MAX_MATCHES, languageCode: 'en' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
    const res = this.meter ? await this.meter.fetchGoogle('text_search_pro', SEARCH_URL, init) : await fetch(SEARCH_URL, init);
    if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}): ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as { places?: any[] };
    const matches: ProviderMatch[] = (data.places ?? [])
      .filter(p => typeof p?.location?.latitude === 'number' && typeof p?.location?.longitude === 'number' && p.id)
      .slice(0, MAX_MATCHES)
      .map(p => ({
        providerPlaceId: p.id,
        name: p.displayName?.text ?? '',
        address: p.formattedAddress,
        location: { latitude: p.location.latitude, longitude: p.location.longitude },
        types: Array.isArray(p.types) ? p.types : []
      }));
    this.cache?.set(key, matches);
    return matches;
  }

  /** Accent-insensitive: "Hỏa Lò Prison" and "Hoa Lo Prison Relic" should be a strong match. */
  private fold(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase();
  }

  private calculateSimilarity(a: string, b: string): number {
    const s1 = this.fold(a).replace(/[^a-z0-9]/g, '');
    const s2 = this.fold(b).replace(/[^a-z0-9]/g, '');
    if (s1 === s2) return 0.98;
    if (s1.includes(s2) || s2.includes(s1)) return 0.92;
    // Word overlap
    const w1 = new Set(this.fold(a).split(/\s+/));
    const w2 = new Set(this.fold(b).split(/\s+/));
    let intersection = 0;
    for (const w of w1) {
      if (w2.has(w) && w.length > 2) intersection++;
    }
    const overlap = intersection / Math.max(w1.size, w2.size);
    return Math.max(0.65, Math.min(0.95, overlap * 0.9 + 0.3));
  }

  private mapCategory(rawType: string): string {
    const t = rawType.toUpperCase();
    if (t.includes('CAFE') || t.includes('COFFEE')) return 'CAFE';
    if (t.includes('REST') || t.includes('FOOD') || t.includes('MEAL') || t.includes('BAR')) return 'FOOD';
    if (t === 'AREA') return 'AREA';
    if (t.includes('MARKET')) return 'MARKET';
    if (t.includes('VIEW') || t.includes('PHOTO')) return 'VIEWPOINT';
    if (t.includes('HOTEL') || t.includes('STAY')) return 'HOTEL';
    if (t.includes('SHOP')) return 'SHOPPING';
    if (t.includes('TOUR')) return 'DAY_TOUR';
    return 'ATTRACTION';
  }
}
