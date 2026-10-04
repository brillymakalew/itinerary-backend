import {
  classifyYtDlpError,
  mergeSegments,
  parseJson3,
  parseVtt,
  pickCaptionTrack,
  toVideoInfo
} from '../media-worker/ytDlp';
import { foldName, formatTimestamp, frameTimes, mergePlaces } from '../media-worker/openaiExtractor';
import { dedupeCandidates, isCityLevel, searchArea } from '../media-worker/pipeline';
import { ResolvedCandidate } from '../media-worker/googlePlacesResolver';

describe('caption tracks', () => {
  it('prefers the video’s own language, one track only', () => {
    const auto = { en: [], 'id-orig': [], id: [], vi: [] };
    expect(pickCaptionTrack({}, auto)).toEqual({ language: 'id-orig', automatic: true });
  });

  it('prefers human captions over automatic ones', () => {
    expect(pickCaptionTrack({ en: [], live_chat: [] }, { 'en-orig': [] })).toEqual({ language: 'en', automatic: false });
  });

  it('has no track when the video has no captions', () => {
    expect(pickCaptionTrack({}, {})).toBeUndefined();
  });
});

describe('transcripts', () => {
  it('parses YouTube json3 captions and drops music markers', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '[Music]' }] },
        { tStartMs: 8505 },
        { tStartMs: 9840, dDurationMs: 3920, segs: [{ utf8: 'Xin chào ' }, { utf8: 'everyone' }] },
        { tStartMs: 13000, dDurationMs: 1000, segs: [{ utf8: '\n' }] }
      ]
    });
    expect(parseJson3(raw)).toEqual([{ start: 9.84, end: 13.76, text: 'Xin chào everyone' }]);
  });

  it('parses WebVTT and drops rolling repeats', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
first we go to <c>Cafe Giang</c>

00:00:03.000 --> 00:00:05.000
first we go to Cafe Giang
for egg coffee`;
    const segments = parseVtt(vtt);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ start: 1, end: 3, text: 'first we go to Cafe Giang' });
    expect(segments[1].text).toBe('for egg coffee');
  });

  it('merges short lines into windows', () => {
    const merged = mergeSegments([
      { start: 0, end: 2, text: 'a' },
      { start: 2, end: 4, text: 'b' },
      { start: 12, end: 14, text: 'c' }
    ], 10);
    expect(merged).toEqual([
      { start: 0, end: 14, text: 'a b c' }
    ]);
  });
});

describe('video details', () => {
  it('maps yt-dlp JSON', () => {
    const info = toVideoInfo({
      id: 'x',
      title: 'Hanoi food',
      description: 'Places: Cafe Giang',
      uploader: 'Locavore',
      duration: 1478,
      chapters: [{ start_time: 0, end_time: 60, title: ' Intro ' }],
      automatic_captions: { 'en-orig': [] }
    });
    expect(info.durationSeconds).toBe(1478);
    expect(info.chapters).toEqual([{ startSeconds: 0, endSeconds: 60, title: 'Intro' }]);
    expect(info.captionTrack).toEqual({ language: 'en-orig', automatic: true });
    expect(info.isLive).toBe(false);
  });

  it('explains yt-dlp failures in plain words', () => {
    expect(classifyYtDlpError('ERROR: [TikTok] 123: This video is private').kind).toBe('private');
    expect(classifyYtDlpError("ERROR: Sign in to confirm you’re not a bot").kind).toBe('blocked');
    expect(classifyYtDlpError('ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required').kind).toBe('blocked');
    expect(classifyYtDlpError('ERROR: Video unavailable').kind).toBe('unavailable');
    expect(classifyYtDlpError('ERROR: Unsupported URL: https://example.com').kind).toBe('unsupported');
  });
});

describe('frames and timestamps', () => {
  it('spreads frames across the whole video', () => {
    const times = frameTimes(79);
    expect(times).toHaveLength(16);
    expect(times[0]).toBeLessThan(5);
    expect(times[times.length - 1]).toBeGreaterThan(70);
    expect(frameTimes(12)).toHaveLength(4);
  });

  it('formats timestamps', () => {
    expect(formatTimestamp(75)).toBe('1:15');
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });
});

describe('merging the same place', () => {
  it('folds accents for comparison', () => {
    expect(foldName('Phở 10 Lý Quốc Sư')).toBe(foldName('Pho 10 Ly Quoc Su'));
    expect(foldName('Đồng Xuân Market')).toBe('dong xuan market');
  });

  it('merges places found in different transcript parts', () => {
    const merged = mergePlaces([
      [{ raw_name: 'Café Giảng', place_type: 'cafe', evidence: [{ type: 'speech', text: 'a' }], model_confidence: 0.8 }],
      [{ raw_name: 'Cafe Giang', place_type: 'cafe', evidence: [{ type: 'speech', text: 'b' }], model_confidence: 0.9, tip: 'Go upstairs' }]
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].evidence).toHaveLength(2);
    expect(merged[0].model_confidence).toBe(0.9);
    expect(merged[0].tip).toBe('Go upstairs');
  });

  const candidate = (id: string, placeId: string | undefined, rawName: string, text: string): ResolvedCandidate => ({
    id,
    sourceId: 'src',
    rawName,
    category: 'CAFE',
    modelConfidence: 0.8,
    resolutionConfidence: 0.9,
    confidenceBand: 'HIGH',
    reviewState: 'PENDING',
    evidence: [{ type: 'speech', text, chipLabel: 'spoken' }],
    topMatch: placeId
      ? { providerPlaceId: placeId, name: rawName, location: { latitude: 0, longitude: 0 }, category: 'CAFE' }
      : undefined,
    options: []
  });

  it('merges mentions that resolve to the same Google place', () => {
    const result = dedupeCandidates([
      candidate('a', 'ChIJ1', 'Cafe Giang', 'first'),
      candidate('b', 'ChIJ1', 'Giang Cafe', 'second'),
      candidate('c', 'ChIJ2', 'Pho 10', 'third')
    ]);
    expect(result.map(c => c.id)).toEqual(['a', 'c']);
    expect(result[0].evidence.map(e => e.text)).toEqual(['first', 'second']);
  });

  it('recognizes whole cities, which are not stops', () => {
    const city = candidate('h', 'ChIJh', 'Hanoi', 'go to Hanoi');
    city.topMatch!.types = ['locality', 'political'];
    const cafe = candidate('c', 'ChIJc', 'Cafe Giang', 'egg coffee');
    cafe.topMatch!.types = ['cafe', 'food', 'point_of_interest'];
    const district = candidate('d', 'ChIJd', 'Hoi An', 'Hoi An');
    district.topMatch!.types = ['political', 'sublocality', 'sublocality_level_1'];
    const bay = candidate('b', 'ChIJb', 'Ha Long Bay', 'cruise');
    bay.topMatch!.types = ['establishment', 'natural_feature'];
    expect(isCityLevel(city)).toBe(true);
    expect(isCityLevel(district)).toBe(true);
    expect(isCityLevel(cafe)).toBe(false);
    expect(isCityLevel(bay)).toBe(false);
  });

  it('uses the trip’s first town for searches', () => {
    expect(searchArea('Hanoi and Sapa, Vietnam')).toBe('Hanoi, Vietnam');
    expect(searchArea('Tokyo, Japan')).toBe('Tokyo, Japan');
  });
});
