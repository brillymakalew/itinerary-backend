// Offline travel-time model. Mirrors android core/model TravelEstimator so the app and the
// optimizer agree on minutes and meters for the same pair of coordinates.

export type TravelMode = 'WALK' | 'DRIVE' | 'TWO_WHEELER' | 'TRANSIT';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface TravelEstimate {
  mode: TravelMode;
  minutes: number;
  meters: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
/** Streets are rarely straight: scale crow-flies distance to an approximate route length. */
const ROUTE_DETOUR_FACTOR = 1.3;
/** Beyond this, walking is unrealistic in a busy city and a ride-hail is assumed. */
export const MAX_COMFORTABLE_WALK_METERS = 2_000;
/** Used when a stop has no coordinates (e.g. an airport transfer without a saved place). */
export const UNKNOWN_LEG_MINUTES = 15;

const toRadians = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLat = lat2 - lat1;
  const dLng = toRadians(to.longitude - from.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function estimateTravel(from: LatLng, to: LatLng, preferred: TravelMode = 'WALK'): TravelEstimate {
  const meters = Math.round(distanceMeters(from, to) * ROUTE_DETOUR_FACTOR);
  const mode: TravelMode = preferred === 'WALK' && meters > MAX_COMFORTABLE_WALK_METERS ? 'DRIVE' : preferred;
  let minutes: number;
  switch (mode) {
    case 'WALK':
      minutes = meters / 80; // ~4.8 km/h
      break;
    case 'DRIVE':
      minutes = 5 + meters / 370; // ~22 km/h city traffic plus pickup
      break;
    case 'TWO_WHEELER':
      minutes = 3 + meters / 420;
      break;
    case 'TRANSIT':
      minutes = 8 + meters / 250;
      break;
  }
  return { mode, minutes: Math.max(1, Math.ceil(minutes)), meters };
}
