// Google Places Resolver (PRD §6.3, §9.3 Stage 7 & §15.2)

import { ExtractedPlace, ExtractedEvidence } from './openaiExtractor';

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
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Resolve an extracted candidate against Google Places API (PRD §9.3 Stage 7)
   */
  async resolve(candidate: ExtractedPlace, sourceId: string): Promise<ResolvedCandidate> {
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const query = `${candidate.raw_name} ${candidate.city_or_area_hint || 'Hanoi'} Vietnam`;

    let providerMatches: any[] = [];

    if (this.apiKey && !this.apiKey.includes('your-google-places')) {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${this.apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (Array.isArray(data.results)) {
            providerMatches = data.results
              .filter((r: any) => typeof r.geometry?.location?.lat === 'number')
              .slice(0, 4)
              .map((r: any) => ({
                providerPlaceId: r.place_id,
                name: r.name,
                address: r.formatted_address,
                location: {
                  latitude: r.geometry.location.lat,
                  longitude: r.geometry.location.lng
                },
                rating: r.rating,
                priceLevel: r.price_level,
                types: r.types || []
              }));
          }
        }
      } catch (err) {
        console.warn(`[GooglePlacesResolver] Text search error for "${query}":`, err);
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
      evidence: formattedEvidence,
      topMatch: topMatch
        ? {
            providerPlaceId: topMatch.providerPlaceId,
            name: topMatch.name,
            address: topMatch.address,
            location: topMatch.location,
            rating: topMatch.rating,
            priceLevel: topMatch.priceLevel,
            category: this.mapCategory(candidate.place_type)
          }
        : undefined,
      options: scoredOptions
    };
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
    if (t.includes('REST') || t.includes('FOOD') || t.includes('MEAL')) return 'FOOD';
    if (t.includes('MARKET')) return 'MARKET';
    if (t.includes('VIEW') || t.includes('PHOTO')) return 'VIEWPOINT';
    if (t.includes('HOTEL') || t.includes('STAY')) return 'HOTEL';
    if (t.includes('SHOP')) return 'SHOPPING';
    if (t.includes('TOUR')) return 'DAY_TOUR';
    return 'ATTRACTION';
  }
}
