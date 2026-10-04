// Social Media Ingestion Adapters (PRD §6.1, §9.3 Stage 1 & 2)

export type SourcePlatform = 'tiktok' | 'instagram' | 'youtube' | 'google_maps' | 'other_url';

export interface SocialMetadata {
  platform: SourcePlatform;
  originalUrl: string;
  normalizedUrl: string;
  title?: string;
  caption?: string;
  authorName?: string;
  thumbnailUrl?: string;
  html?: string;
  hasAnalyzableMedia: boolean;
  /** False when the platform returned nothing (private/removed post, blocked scrape). */
  hasMetadata?: boolean;
}

/**
 * Caption details the app read on the phone. Servers in data centres are often refused by TikTok,
 * while phones on ordinary networks are not, so the app sends what it saw along with the link.
 */
export interface ClientPreview {
  title?: string;
  description?: string;
  authorName?: string;
  thumbnailUrl?: string;
  /**
   * YouTube captions the phone read (YouTube refuses servers in data centres). Each line starts at
   * [start] seconds into the video.
   */
  transcript?: { start: number; text: string }[];
  durationSeconds?: number;
}

/** Query parameters that only track the share and never change which post is meant. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'igsh', 'igshid', 'is_from_webapp', 'sender_device', 'sender_web_id', 't', '_r', '_t',
  'si', 'feature', 'pp', 'g_st', 'entry'
];

/** oEmbed answers HTTP 503 "overload-protect" to a share of requests at random; retrying works. */
const OEMBED_ATTEMPTS = 4;
const OEMBED_RETRY_DELAYS_MS = [350, 900, 1800];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0'
  );
}

/** google.com, google.co.id, google.com.vn, … */
export function isGoogleHost(hostname: string): boolean {
  return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(hostname);
}

export function detectPlatform(url: URL): SourcePlatform {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.toLowerCase();
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (
    host === 'maps.app.goo.gl' ||
    (host === 'goo.gl' && path.startsWith('/maps')) ||
    host === 'g.page' ||
    host.startsWith('maps.google.') ||
    (isGoogleHost(host) && path.startsWith('/maps'))
  ) {
    return 'google_maps';
  }
  return 'other_url';
}

export class SocialAdapters {
  /** Metadata from the app's preview, or null when it carries no caption text to analyze. */
  static fromClientPreview(url: string, platform: SourcePlatform, preview?: ClientPreview): SocialMetadata | null {
    const title = preview?.title?.trim() || undefined;
    const caption = preview?.description?.trim() || title;
    if (!caption) return null;
    return {
      platform,
      originalUrl: url,
      normalizedUrl: this.normalizeUrl(url).normalizedUrl,
      title,
      caption,
      authorName: preview?.authorName?.trim() || undefined,
      thumbnailUrl: preview?.thumbnailUrl?.startsWith('https://') ? preview.thumbnailUrl : undefined,
      hasAnalyzableMedia: false,
      hasMetadata: true
    };
  }

  /**
   * Stage 1: URL Normalization & SSRF Protection
   */
  static normalizeUrl(rawUrl: string): { normalizedUrl: string; platform: SourcePlatform } {
    let cleanUrl = rawUrl.trim();
    // Extract first URL if text contains surrounding share text
    const urlMatch = cleanUrl.match(/https?:\/\/[^\s<>"']+/);
    if (urlMatch) {
      cleanUrl = urlMatch[0].replace(/[.,)!?]+$/, '');
    }

    try {
      const parsed = new URL(cleanUrl);
      if (isPrivateHost(parsed.hostname.toLowerCase())) {
        throw new Error('Disallowed hostname for security');
      }
      const platform = detectPlatform(parsed);
      // Google Maps links carry the place in their parameters; leave them untouched.
      if (platform !== 'google_maps') {
        for (const p of TRACKING_PARAMS) parsed.searchParams.delete(p);
      }
      return { normalizedUrl: parsed.toString(), platform };
    } catch {
      return { normalizedUrl: cleanUrl, platform: 'other_url' };
    }
  }

  /**
   * Stage 2: Official Metadata Retrieval (TikTok oEmbed & Open Graph tags)
   */
  static async fetchMetadata(url: string, platform: SourcePlatform): Promise<SocialMetadata> {
    const { normalizedUrl } = this.normalizeUrl(url);

    if (platform === 'tiktok') {
      const oembed = await this.fetchTikTokOEmbed(normalizedUrl);
      if (oembed) {
        return {
          platform: 'tiktok',
          originalUrl: url,
          normalizedUrl,
          title: oembed.title,
          caption: oembed.title,
          authorName: oembed.author_name,
          thumbnailUrl: oembed.thumbnail_url,
          html: oembed.html,
          hasAnalyzableMedia: false, // oEmbed delivers caption and thumbnail, not full raw MP4
          hasMetadata: Boolean(oembed.title || oembed.thumbnail_url)
        };
      }
    }

    // Instagram and ordinary web pages: read the public Open Graph tags.
    if (platform !== 'tiktok') {
      try {
        const res = await fetch(normalizedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) console.warn(`[Page metadata] HTTP ${res.status} for ${normalizedUrl}`);
        if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
          const html = (await res.text()).slice(0, 500_000);
          const meta = (property: string) =>
            html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1];
          const title = meta('og:title') ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
          const description = meta('og:description') ?? meta('description');
          const image = meta('og:image');

          return {
            platform,
            originalUrl: url,
            normalizedUrl,
            title: title ? decodeEntities(title) : undefined,
            caption: description ? decodeEntities(description) : title ? decodeEntities(title) : undefined,
            thumbnailUrl: image,
            hasAnalyzableMedia: false,
            hasMetadata: Boolean(description || image)
          };
        }
      } catch (err) {
        console.warn(`[Page metadata] Fallback for ${url}:`, err);
      }
    }

    // Generic fallback for other URLs
    return {
      platform,
      originalUrl: url,
      normalizedUrl,
      title: normalizedUrl,
      caption: undefined,
      hasAnalyzableMedia: false,
      hasMetadata: false
    };
  }

  private static async fetchTikTokOEmbed(normalizedUrl: string): Promise<{
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
    html?: string;
  } | null> {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(normalizedUrl)}`;
    for (let attempt = 1; attempt <= OEMBED_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(oembedUrl, {
          headers: { 'User-Agent': 'Vibi-Travel-App/1.0' },
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) return (await res.json()) as any;
        const body = (await res.text()).slice(0, 160);
        // 400/404 mean the post itself is unavailable; only overload and rate limits are worth a retry.
        const retryable = res.status === 429 || res.status >= 500;
        console.warn(`[TikTok oEmbed] HTTP ${res.status} for ${normalizedUrl} (attempt ${attempt}): ${body}`);
        if (!retryable) return null;
      } catch (err: any) {
        console.warn(`[TikTok oEmbed] attempt ${attempt} failed for ${normalizedUrl}:`, err?.message ?? err);
      }
      if (attempt < OEMBED_ATTEMPTS) await sleep(OEMBED_RETRY_DELAYS_MS[attempt - 1] ?? 1800);
    }
    return null;
  }
}

/** Meta tag content arrives HTML-escaped (e.g. `&amp;`, `&#39;`, `&#x1F35C;`). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
