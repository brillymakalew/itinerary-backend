// Place Resolution & Confidence Scoring Engine (PRD §9.3 Stage 7 & Stage 8)

export interface RawCandidate {
  rawName: string;
  category: string;
  cityOrAreaHint?: string;
  modelConfidence: number;
}

export interface PlaceMatch {
  providerPlaceId: string;
  name: String;
  address: string;
  lat: number;
  lng: number;
  confidence: number;
}

export interface ResolutionResult {
  candidateName: string;
  topMatch?: PlaceMatch;
  confidenceBand: 'HIGH' | 'CHECK' | 'LOW';
  reviewRequired: boolean;
  options: PlaceMatch[];
}

export class PlaceResolver {
  /**
   * Evaluates place candidates against map provider candidates and computes confidence.
   * Rules per PRD §9.3 Stage 7:
   * - >= 0.90: HIGH (auto-preselect, show evidence)
   * - 0.70 - 0.89: CHECK (show top match with "Check this match")
   * - < 0.70: LOW (ask user to choose or search manually)
   */
  resolveCandidate(raw: RawCandidate, providerCandidates: PlaceMatch[]): ResolutionResult {
    if (providerCandidates.length === 0) {
      return {
        candidateName: raw.rawName,
        confidenceBand: 'LOW',
        reviewRequired: true,
        options: []
      };
    }

    const top = providerCandidates[0];
    const band: 'HIGH' | 'CHECK' | 'LOW' =
      top.confidence >= 0.90 ? 'HIGH' : top.confidence >= 0.70 ? 'CHECK' : 'LOW';

    return {
      candidateName: raw.rawName,
      topMatch: top,
      confidenceBand: band,
      reviewRequired: band !== 'HIGH',
      options: providerCandidates
    };
  }
}
