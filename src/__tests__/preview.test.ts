import { SocialAdapters } from '../media-worker/adapters/socialAdapters';
import { isImageDownloadError } from '../media-worker/openaiExtractor';

describe('caption read by the app', () => {
  const url = 'https://vt.tiktok.com/ZSbmtFnuF/';

  it('uses the TikTok caption (oEmbed title) the phone sent', () => {
    const meta = SocialAdapters.fromClientPreview(url, 'tiktok', {
      title: 'Semua tempat MAKAN & NGOPI di HANOI: Cafe Giang, Bun Cha Huong Lien',
      authorName: 'SERLY',
      thumbnailUrl: 'https://p16-sign-sg.tiktokcdn.com/thumb.jpeg'
    });
    expect(meta?.hasMetadata).toBe(true);
    expect(meta?.caption).toContain('Cafe Giang');
    expect(meta?.authorName).toBe('SERLY');
    expect(meta?.thumbnailUrl).toBe('https://p16-sign-sg.tiktokcdn.com/thumb.jpeg');
  });

  it('prefers a description over the title', () => {
    const meta = SocialAdapters.fromClientPreview(url, 'tiktok', { title: 'Title', description: 'Full caption' });
    expect(meta?.caption).toBe('Full caption');
  });

  it('is ignored when it has no caption text', () => {
    expect(SocialAdapters.fromClientPreview(url, 'tiktok', undefined)).toBeNull();
    expect(SocialAdapters.fromClientPreview(url, 'tiktok', { title: '   ', thumbnailUrl: 'https://x/y.jpg' })).toBeNull();
  });

  it('drops thumbnails that are not https', () => {
    const meta = SocialAdapters.fromClientPreview(url, 'tiktok', { title: 'Caption', thumbnailUrl: 'http://10.0.0.1/x.jpg' });
    expect(meta?.thumbnailUrl).toBeUndefined();
  });
});

describe('thumbnail download failures', () => {
  it('are recognized so the caption can be analyzed alone', () => {
    expect(isImageDownloadError({ status: 400, code: 'invalid_image_url', message: 'Error while downloading https://…' })).toBe(true);
    expect(isImageDownloadError({ status: 400, message: 'Timeout while downloading image' })).toBe(true);
  });

  it('do not swallow other errors', () => {
    expect(isImageDownloadError({ status: 401, message: 'Incorrect API key' })).toBe(false);
    expect(isImageDownloadError({ status: 400, message: "'messages' must contain the word 'json'" })).toBe(false);
  });
});
