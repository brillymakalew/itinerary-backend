import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig } from '../config';
import { MediaProcessingPipeline } from '../media-worker/pipeline';

describe('links saved for later', () => {
  let dataDir: string;
  const link = 'https://vt.tiktok.com/ZSbmtFnuF/';

  const pipeline = () => {
    const config: AppConfig = {
      port: 0,
      apiToken: '',
      openaiApiKey: 'sk-test',
      googleApiKey: '',
      metaOembedToken: null,
      dataDir,
      transcriptionModel: 'whisper-1',
      visionModel: 'gpt-4o-mini',
      extractionModel: 'gpt-4o-mini',
      maxUploadBytes: 1,
      maxFrames: 1,
      pipelineVersion: 'test',
      promptVersion: 'test',
      supabaseUrl: '',
      supabaseServiceRoleKey: '',
      maxConcurrentImports: 1,
      openAiMonthlyBudgetUsd: 5,
      googleFreeCaps: {}
    };
    const noVideoDownloads = { isAvailable: () => Promise.resolve(false) } as any;
    return new MediaProcessingPipeline(config, noVideoDownloads);
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibi-saved-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the link with what the phone read, without analyzing it', () => {
    const job = pipeline().startImportJob('trip_t', link, {
      analyze: false,
      preview: { title: 'Semua tempat MAKAN di Hanoi', authorName: 'serly', thumbnailUrl: 'https://p16.tiktokcdn.com/x.jpeg' }
    });
    expect(job.status).toBe('saved');
    expect(job.caption).toBe('Semua tempat MAKAN di Hanoi');
    expect(job.creatorName).toBe('serly');
    expect(job.candidates).toEqual([]);
    expect(job.queuePosition).toBeUndefined();
  });

  it('returns the same card when the link is saved again', () => {
    const p = pipeline();
    const first = p.startImportJob('trip_t', link, { analyze: false });
    const again = p.startImportJob('trip_t', `${link}?is_from_webapp=1`, { analyze: false });
    expect(again.sourceId).toBe(first.sourceId);
    expect(again.status).toBe('saved');
  });

  it('keeps the id the app sends back after a server restart', () => {
    expect(pipeline().startImportJob('trip_t', link, { analyze: false, sourceId: 'src_1791160299129_v5yn' }).sourceId)
      .toBe('src_1791160299129_v5yn');
    expect(pipeline().startImportJob('trip_t', link, { analyze: false, sourceId: '../etc/passwd' }).sourceId)
      .toMatch(/^src_\d+_/);
  });
});
