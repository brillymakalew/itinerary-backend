// Finding a specific place: search by name (for "Add a stop") and Google Maps share links
// (maps.app.goo.gl/…). Uses Places API (New); the key never leaves the server.

import { distanceMeters, LatLng } from '../itinerary/travel';
import { isGoogleHost } from '../media-worker/adapters/socialAdapters';

export interface PlaceSummary {
  providerPlaceId: string;
  name: string;
  address?: string;
  location: LatLng;
  /** The app's category name: FOOD, CAFE, ATTRACTION, … */
  category: string;
  types: string[];
  rating?: number;
  userRatingCount?: number;
  priceLevel?: number;
  googleMapsUri?: string;
}

export interface ParsedMapsLink {
  name?: string;
  location?: LatLng;
  placeId?: string;
}

export class PlaceLookupError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

const PLACES_API = 'https://places.googleapis.com/v1';
const FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'types', 'primaryType', 'rating', 'userRatingCount', 'priceLevel', 'googleMapsUri'];
const SEARCH_FIELD_MASK = FIELDS.map(f => `places.${f}`).join(',');
const DETAIL_FIELD_MASK = FIELDS.join(',');
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 6;
/** A named link's coordinates and the place Google finds for that name should be this close. */
const MAX_LINK_MATCH_METERS = 2_000;
/** A bare pin only counts as a place when one is right there. */
const MAX_PIN_MATCH_METERS = 60;

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4
};

const CATEGORY_TYPES: [string, string[]][] = [
  ['CAFE', ['cafe', 'coffee_shop', 'tea_house', 'cafeteria', 'dessert_shop', 'juice_shop']],
  ['FOOD', ['restaurant', 'food', 'meal_takeaway', 'meal_delivery', 'bakery', 'bar', 'pub', 'food_court', 'night_club', 'wine_bar']],
  ['HOTEL', ['lodging', 'hotel', 'hostel', 'motel', 'resort_hotel', 'guest_house', 'bed_and_breakfast', 'inn']],
  ['MARKET', ['market', 'farmers_market', 'flea_market']],
  ['SHOPPING', ['shopping_mall', 'store', 'clothing_store', 'department_store', 'gift_shop', 'book_store', 'jewelry_store', 'supermarket', 'convenience_store']],
  ['VIEWPOINT', ['observation_deck', 'scenic_spot', 'viewpoint']],
  ['DAY_TOUR', ['travel_agency', 'tour_agency', 'tourist_information_center']],
  ['TRANSPORT', ['airport', 'train_station', 'bus_station', 'transit_station', 'subway_station', 'ferry_terminal', 'taxi_stand', 'light_rail_station']],
  ['ATTRACTION', ['tourist_attraction', 'museum', 'park', 'art_gallery', 'church', 'hindu_temple', 'buddhist_temple', 'place_of_worship', 'zoo', 'amusement_park', 'historical_landmark', 'monument', 'cultural_landmark', 'national_park', 'hiking_area', 'beach', 'aquarium', 'performing_arts_theater']],
  ['AREA', ['locality', 'sublocality', 'neighborhood', 'administrative_area_level_1', 'administrative_area_level_2', 'route', 'political']]
];

/** Maps Google place types onto the app's categories, primary type first. */
export function categoryFromTypes(types: string[], primaryType?: string): string {
  const ordered = [primaryType, ...types].filter((t): t is string => Boolean(t));
  for (const type of ordered) {
    if (type.endsWith('_restaurant') || type.endsWith('_bar')) return 'FOOD';
    for (const [category, list] of CATEGORY_TYPES) {
      if (list.includes(type)) return category;
    }
  }
  return 'OTHER';
}

const decodePart = (part: string) => {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' ')).trim();
  } catch {
    return part.replace(/\+/g, ' ').trim();
  }
};

const COORDS = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function parseCoords(text: string | null | undefined): LatLng | undefined {
  const match = text?.match(COORDS);
  if (!match) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/**
 * Reads the place a Google Maps URL points at: its name (`/maps/place/<name>/`), exact pin
 * (`!3d<lat>!4d<lng>`, else `@lat,lng`), a place id (`query_place_id=ChIJ…`) or a search (`?q=`).
 */
export function parseGoogleMapsUrl(raw: string): ParsedMapsLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {};
  }
  const result: ParsedMapsLink = {};
  const segments = url.pathname.split('/').filter(Boolean);
  const placeIndex = segments.findIndex(s => s === 'place' || s === 'search');
  if (placeIndex >= 0 && segments[placeIndex + 1] && !segments[placeIndex + 1].startsWith('@')) {
    const value = decodePart(segments[placeIndex + 1]);
    const coords = parseCoords(value);
    if (coords) result.location = coords;
    else result.name = value;
  }

  const decoded = decodePart(url.href);
  const pin = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const at = decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (pin) result.location = { latitude: Number(pin[1]), longitude: Number(pin[2]) };
  else if (!result.location && at) result.location = { latitude: Number(at[1]), longitude: Number(at[2]) };

  const params = url.searchParams;
  const placeId = params.get('query_place_id') || params.get('destination_place_id') || params.get('place_id');
  if (placeId) result.placeId = placeId;
  for (const key of ['q', 'query', 'destination', 'daddr']) {
    const value = params.get(key);
    if (!value) continue;
    const coords = parseCoords(value);
    if (coords) result.location = result.location ?? coords;
    else result.name = result.name ?? value.replace(/\+/g, ' ').trim();
  }
  const ll = parseCoords(params.get('ll'));
  if (ll && !result.location) result.location = ll;
  return result;
}

function isAllowedRedirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.page' || host.startsWith('maps.google.') || isGoogleHost(host);
}

export class PlaceLookupService {
  constructor(private readonly apiKey: string) {}

  get isConfigured(): boolean {
    return Boolean(this.apiKey) && !this.apiKey.includes('your-google-places');
  }

  /** Name search, biased toward [near] when given (e.g. the day's city). */
  async search(query: string, near?: LatLng, radiusMeters = 30_000, maxResults = 8): Promise<PlaceSummary[]> {
    const body: Record<string, unknown> = { textQuery: query, maxResultCount: maxResults, languageCode: 'en' };
    if (near) body.locationBias = { circle: { center: near, radius: Math.min(radiusMeters, 50_000) } };
    const data = await this.post('places:searchText', body, SEARCH_FIELD_MASK);
    return (data.places ?? []).map((p: any) => this.toSummary(p)).filter(Boolean) as PlaceSummary[];
  }

  async details(placeId: string): Promise<PlaceSummary | null> {
    this.requireKey();
    const res = await fetch(`${PLACES_API}/places/${encodeURIComponent(placeId)}?languageCode=en`, {
      headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': DETAIL_FIELD_MASK },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Place details failed (HTTP ${res.status})`);
    return this.toSummary(await res.json());
  }

  /**
   * The place behind a Google Maps link or share text ("Café Giảng\nhttps://maps.app.goo.gl/…").
   * Text before the link is used as the name when the link itself carries none.
   */
  async resolveMapsLink(text: string): Promise<PlaceSummary> {
    this.requireKey();
    const urlMatch = text.match(/https?:\/\/[^\s<>"']+/);
    if (!urlMatch) throw new PlaceLookupError('That doesn’t contain a Google Maps link.');
    const shareName = text.slice(0, urlMatch.index).split('\n').map(l => l.trim()).find(Boolean);
    const finalUrl = await this.followRedirects(urlMatch[0].replace(/[.,)!?]+$/, ''));
    const parsed = parseGoogleMapsUrl(finalUrl);
    const name = parsed.name ?? shareName;

    if (parsed.placeId) {
      const byId = await this.details(parsed.placeId).catch(() => null);
      if (byId) return byId;
    }
    if (name) {
      const results = await this.search(name, parsed.location, parsed.location ? 2_000 : 30_000, 5);
      const nearby = parsed.location
        ? results
            .map(p => ({ p, d: distanceMeters(parsed.location!, p.location) }))
            .filter(x => x.d <= MAX_LINK_MATCH_METERS)
            .sort((a, b) => a.d - b.d)
            .map(x => x.p)
        : results;
      const best = nearby[0] ?? (parsed.location ? undefined : results[0]);
      if (best) return best;
    }
    if (parsed.location) {
      const pinned = await this.nearest(parsed.location);
      if (pinned) return pinned;
      throw new PlaceLookupError('This link is a dropped pin, not a place. Open the place itself in Google Maps and share that.');
    }
    throw new PlaceLookupError('Couldn’t find a place in that Google Maps link.');
  }

  /** Follows a short link to the full Maps URL without ever leaving Google's domains. */
  async followRedirects(start: string): Promise<string> {
    let current = start;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const url = new URL(current);
      if (!isAllowedRedirectHost(url.hostname)) throw new PlaceLookupError('That isn’t a Google Maps link.');
      // EU cookie consent wraps the real address in ?continue=.
      if (url.hostname.startsWith('consent.')) {
        const next = url.searchParams.get('continue');
        if (!next) break;
        current = next;
        continue;
      }
      if (parseGoogleMapsUrl(current).name || parseGoogleMapsUrl(current).placeId || url.pathname.startsWith('/maps/place')) {
        return current;
      }
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return current;
    }
    return current;
  }

  private async nearest(location: LatLng): Promise<PlaceSummary | null> {
    const data = await this.post(
      'places:searchNearby',
      { locationRestriction: { circle: { center: location, radius: MAX_PIN_MATCH_METERS } }, maxResultCount: 5, rankPreference: 'DISTANCE', languageCode: 'en' },
      SEARCH_FIELD_MASK
    );
    const places = (data.places ?? []).map((p: any) => this.toSummary(p)).filter(Boolean) as PlaceSummary[];
    return places.find(p => p.category !== 'AREA') ?? null;
  }

  private async post(path: string, body: unknown, fieldMask: string): Promise<any> {
    this.requireKey();
    const res = await fetch(`${PLACES_API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Places request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  private requireKey() {
    if (!this.isConfigured) throw new PlaceLookupError('Place search needs GOOGLE_PLACES_API_KEY on the server.', 503);
  }

  private toSummary(place: any): PlaceSummary | null {
    const lat = place?.location?.latitude;
    const lng = place?.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !place?.id) return null;
    const types: string[] = Array.isArray(place.types) ? place.types : [];
    return {
      providerPlaceId: place.id,
      name: place.displayName?.text ?? 'Unnamed place',
      address: place.formattedAddress,
      location: { latitude: lat, longitude: lng },
      category: categoryFromTypes(types, place.primaryType),
      types,
      rating: place.rating,
      userRatingCount: place.userRatingCount,
      priceLevel: place.priceLevel ? PRICE_LEVELS[place.priceLevel] : undefined,
      googleMapsUri: place.googleMapsUri
    };
  }
}
