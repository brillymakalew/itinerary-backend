import { SocialAdapters } from '../media-worker/adapters/socialAdapters';
import { categoryFromTypes, parseGoogleMapsUrl } from '../places/placeLookup';

describe('link platforms', () => {
  const platform = (url: string) => SocialAdapters.normalizeUrl(url).platform;

  it('recognizes video platforms', () => {
    expect(platform('https://vt.tiktok.com/ZSbmtFnuF/')).toBe('tiktok');
    expect(platform('https://www.instagram.com/reel/DYlnbrcS3xW/?igsh=abc')).toBe('instagram');
    expect(platform('https://www.youtube.com/watch?v=S_214UcpS90')).toBe('youtube');
    expect(platform('https://youtu.be/S_214UcpS90?si=tracking')).toBe('youtube');
    expect(platform('https://m.youtube.com/shorts/abc123')).toBe('youtube');
  });

  it('recognizes Google Maps links in their share formats', () => {
    expect(platform('https://maps.app.goo.gl/AbCdEf123')).toBe('google_maps');
    expect(platform('https://goo.gl/maps/xyz')).toBe('google_maps');
    expect(platform('https://www.google.com/maps/place/Cafe+Giang/@21.03,105.85,17z')).toBe('google_maps');
    expect(platform('https://maps.google.com/?q=Cafe+Giang')).toBe('google_maps');
    expect(platform('https://www.google.co.id/maps/place/Pho+10')).toBe('google_maps');
    expect(platform('https://www.google.com/search?q=pho')).toBe('other_url');
  });

  it('finds the link inside share text and strips tracking only where safe', () => {
    const tiktok = SocialAdapters.normalizeUrl('Look! https://www.tiktok.com/@a/video/1?_r=1&_t=ZS-9 wow');
    expect(tiktok.normalizedUrl).toBe('https://www.tiktok.com/@a/video/1');
    const youtube = SocialAdapters.normalizeUrl('https://youtu.be/S_214UcpS90?si=abc');
    expect(youtube.normalizedUrl).toBe('https://youtu.be/S_214UcpS90');
    const maps = SocialAdapters.normalizeUrl('https://maps.google.com/?q=Cafe+Giang&entry=ttu');
    expect(maps.normalizedUrl).toContain('entry=ttu');
  });

  it('refuses private network addresses', () => {
    expect(SocialAdapters.normalizeUrl('http://192.168.1.10/admin').platform).toBe('other_url');
  });
});

describe('Google Maps URLs', () => {
  it('reads the name and exact pin from a place link', () => {
    const parsed = parseGoogleMapsUrl(
      'https://www.google.com/maps/place/Caf%C3%A9+Gi%E1%BA%A3ng/@21.0336,105.8520,17z/data=!3m1!4b1!4m6!3m5!1s0x3135ab:0x75d0!8m2!3d21.0337!4d105.8543!16s%2Fg%2F1tf2qbgw'
    );
    expect(parsed.name).toBe('Café Giảng');
    expect(parsed.location).toEqual({ latitude: 21.0337, longitude: 105.8543 });
  });

  it('reads search and place-id links', () => {
    expect(parseGoogleMapsUrl('https://maps.google.com/?q=Bun+Cha+Huong+Lien&ftid=0x1:0x2').name).toBe('Bun Cha Huong Lien');
    const byId = parseGoogleMapsUrl('https://www.google.com/maps/search/?api=1&query=Pho+10&query_place_id=ChIJabc123');
    expect(byId.placeId).toBe('ChIJabc123');
    expect(byId.name).toBe('Pho 10');
  });

  it('treats coordinates as a pin, not a name', () => {
    const pin = parseGoogleMapsUrl('https://maps.google.com/?q=21.0285,105.8542');
    expect(pin.name).toBeUndefined();
    expect(pin.location).toEqual({ latitude: 21.0285, longitude: 105.8542 });
  });

  it('maps Google place types to app categories', () => {
    expect(categoryFromTypes(['cafe', 'food', 'point_of_interest'])).toBe('CAFE');
    expect(categoryFromTypes(['point_of_interest'], 'vietnamese_restaurant')).toBe('FOOD');
    expect(categoryFromTypes(['lodging'], 'hotel')).toBe('HOTEL');
    expect(categoryFromTypes(['tourist_attraction', 'museum'])).toBe('ATTRACTION');
    expect(categoryFromTypes(['point_of_interest'])).toBe('OTHER');
  });
});
