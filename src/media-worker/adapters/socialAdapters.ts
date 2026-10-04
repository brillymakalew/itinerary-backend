// Social Media Ingestion Adapters (PRD §6.1, §9.3 Stage 1 & 2)

export interface SocialMetadata {
  platform: 'tiktok' | 'instagram' | 'other_url';
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

export class SocialAdapters {
  /**
   * Stage 1: URL Normalization & SSRF Protection
   */
  static normalizeUrl(rawUrl: string): { normalizedUrl: string; platform: SocialMetadata['platform'] } {
    let cleanUrl = rawUrl.trim();
    // Extract first URL if text contains surrounding share text
    const urlMatch = cleanUrl.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      cleanUrl = urlMatch[0];
    }

    try {
      const parsed = new URL(cleanUrl);
      // SSRF security check: forbid private/loopback IP addresses
      const hostname = parsed.hostname.toLowerCase();
      if (
        hostname === 'localhost' ||
        hostname.startsWith('127.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname === '[::1]' ||
        hostname === '0.0.0.0'
      ) {
        throw new Error('Disallowed hostname for security');
      }

      // Strip tracking query parameters
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'igsh', 'is_from_webapp', 'sender_device', 't'];
      for (const p of trackingParams) {
        parsed.searchParams.delete(p);
      }

      let platform: SocialMetadata['platform'] = 'other_url';
      if (hostname.includes('tiktok.com')) {
        platform = 'tiktok';
      } else if (hostname.includes('instagram.com')) {
        platform = 'instagram';
      }

      return {
        normalizedUrl: parsed.toString(),
        platform
      };
    } catch {
      return {
        normalizedUrl: cleanUrl,
        platform: 'other_url'
      };
    }
  }

  /**
   * Stage 2: Official Metadata Retrieval (TikTok oEmbed & Instagram metadata)
   */
  static async fetchMetadata(url: string, platform: SocialMetadata['platform']): Promise<SocialMetadata> {
    const { normalizedUrl } = this.normalizeUrl(url);

    if (platform === 'tiktok') {
      try {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(normalizedUrl)}`;
        const res = await fetch(oembedUrl, {
          headers: { 'User-Agent': 'Vibi-Travel-App/1.0' },
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
          const data = (await res.json()) as {
            title?: string;
            author_name?: string;
            thumbnail_url?: string;
            html?: string;
          };
          return {
            platform: 'tiktok',
            originalUrl: url,
            normalizedUrl,
            title: data.title,
            caption: data.title,
            authorName: data.author_name,
            thumbnailUrl: data.thumbnail_url,
            html: data.html,
            hasAnalyzableMedia: false, // oEmbed delivers caption and thumbnail, not full raw MP4
            hasMetadata: Boolean(data.title || data.thumbnail_url)
          };
        }
      } catch (err) {
        console.warn(`[TikTok oEmbed] Fallback for ${url}:`, err);
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
}

/** Meta tag content arrives HTML-escaped (e.g. `&amp;`, `&#39;`, `&#x1F35C;`). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
