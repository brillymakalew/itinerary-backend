// Multimodal Place Extractor using OpenAI API (PRD §6.2, §9.3 Stage 4, 5, 6)

import OpenAI, { toFile } from 'openai';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import { SocialMetadata } from './adapters/socialAdapters';

const execFileAsync = promisify(execFile);

export interface ExtractedEvidence {
  type: 'speech' | 'caption' | 'onscreen_text' | 'visual_landmark' | 'location_tag';
  text?: string;
  start_seconds?: number;
  end_seconds?: number;
  frame_seconds?: number;
}

export interface ExtractedPlace {
  raw_name: string;
  alternate_names?: string[];
  place_type: string;
  city_or_area_hint?: string;
  country_hint?: string;
  evidence: ExtractedEvidence[];
  model_confidence: number;
}

export interface ExtractionResult {
  source_summary: string;
  detected_languages: string[];
  places: ExtractedPlace[];
}

/** Maps OpenAI SDK failures to messages a traveler (or the server owner) can act on. */
export function describeAiError(err: any): string {
  const status = err?.status as number | undefined;
  if (status === 401) return 'The AI service rejected its API key (check OPENAI_API_KEY on the server).';
  if (status === 429) return 'The AI service is busy or out of credit. Try again in a minute.';
  if (err?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(String(err?.message))) {
    return 'AI analysis timed out. Try again.';
  }
  if (err?.name === 'APIConnectionError') return "Couldn't reach the AI service from the server.";
  return `AI analysis failed: ${err?.message ?? 'unknown error'}`;
}

/** Keeps only well-formed places from model output (the model occasionally omits fields). */
function sanitize(parsed: Partial<ExtractionResult>, fallbackSummary: string): ExtractionResult {
  const places = Array.isArray(parsed.places) ? parsed.places : [];
  return {
    source_summary: parsed.source_summary || fallbackSummary,
    detected_languages: Array.isArray(parsed.detected_languages) ? parsed.detected_languages : [],
    places: places
      .filter(p => p && typeof p.raw_name === 'string' && p.raw_name.trim() !== '')
      .map(p => ({
        ...p,
        place_type: p.place_type || 'other',
        evidence: Array.isArray(p.evidence) ? p.evidence : [],
        model_confidence: typeof p.model_confidence === 'number' ? p.model_confidence : 0.7
      }))
  };
}

export class OpenAiExtractor {
  private openai: OpenAI;
  private model: string;
  private transcriptionModel: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini', transcriptionModel: string = 'whisper-1') {
    // Bounded latency: one quick retry, then fail visibly instead of hanging the import.
    this.openai = new OpenAI({ apiKey, timeout: 45_000, maxRetries: 1 });
    this.model = model;
    this.transcriptionModel = transcriptionModel;
  }

  /**
   * Stage 6: Multimodal Place Extraction from Caption, Metadata & Thumbnail (PRD §9.3)
   */
  async extractFromMetadata(
    metadata: SocialMetadata,
    destinationContext: string = 'Hanoi and Sapa, Vietnam'
  ): Promise<ExtractionResult> {
    const textPrompt = `You are Vibi AI, a travel intelligence system analyzing social media posts for trip planning.
Trip destination context: ${destinationContext}.

Source details:
- Platform: ${metadata.platform}
- Author: ${metadata.authorName || 'Unknown'}
- Caption/Title: ${metadata.caption || metadata.title || 'None'}

Your job is to identify every physical place, restaurant, café, viewpoint, market, hotel, or attraction that the caption names or the attached thumbnail clearly shows.
Rules per PRD §9.3 Stage 6:
1. Extract only real-world physical venues or specific landmarks.
2. Use ONLY the caption text and the thumbnail image above. You cannot watch the video: never claim something is "shown in the video", and never infer places from the URL, the account name, or your general knowledge of the destination.
3. Every place needs evidence: quote the caption words that name it ("caption"), or describe what is visible in the thumbnail ("visual_landmark"). If you cannot cite such evidence, leave the place out.
4. Distinguish dishes/food names (e.g. "Bún chả", "Egg coffee") from venue names (e.g. "Bún Chả Hương Liên", "Café Giảng").
5. Distinguish generic areas (e.g. "Old Quarter", "West Lake") from specific businesses.
6. If the caption and thumbnail don't identify any specific place, return an empty "places" list — that is a correct answer.
7. Provide a model_confidence between 0.0 and 1.0.

Respond strictly with valid JSON conforming to:
{
  "source_summary": "1-2 sentence description of the content",
  "detected_languages": ["vi", "en"],
  "places": [
    {
      "raw_name": "Exact detected venue name",
      "alternate_names": ["English or local variant if any"],
      "place_type": "restaurant|cafe|attraction|shop|hotel|market|area|other",
      "city_or_area_hint": "e.g. Hoan Kiem, Hanoi or Sapa",
      "country_hint": "Vietnam",
      "evidence": [
        {
          "type": "caption|speech|onscreen_text|visual_landmark",
          "text": "Exact text or visual context that proves this place",
          "frame_seconds": null
        }
      ],
      "model_confidence": 0.95
    }
  ]
}`;

    const content: any[] = [{ type: 'text', text: textPrompt }];

    // If thumbnail URL is available, include it in vision input
    if (metadata.thumbnailUrl && metadata.thumbnailUrl.startsWith('http')) {
      content.push({
        type: 'image_url',
        image_url: { url: metadata.thumbnailUrl, detail: 'low' }
      });
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        temperature: 0.2
      });

      const rawJson = response.choices[0]?.message?.content || '{}';
      return sanitize(JSON.parse(rawJson), metadata.caption || 'Extracted places');
    } catch (err) {
      console.error('[OpenAiExtractor] Extraction failed:', err);
      throw new Error(describeAiError(err));
    }
  }

  /**
   * Stage 4 & 5: Video / Audio Upload Processing with Whisper & Frame Sampling (PRD §9.3)
   */
  async extractFromUploadedMedia(
    mediaFilePath: string,
    metadata: SocialMetadata,
    outputDir: string,
    destinationContext: string = 'Hanoi and Sapa, Vietnam'
  ): Promise<ExtractionResult> {
    if (!fs.existsSync(mediaFilePath)) {
      throw new Error(`Media file not found at: ${mediaFilePath}`);
    }

    let transcript = '';
    const transcriptSegments: { start: number; end: number; text: string }[] = [];
    const sampledFramesBase64: { timeSec: number; base64: string }[] = [];
    // A private scratch directory per upload, so concurrent uploads never mix frames.
    const workDir = fs.mkdtempSync(path.join(outputDir, 'job-'));

    try {
      // 1. Audio Extraction & Whisper Transcription
      if (ffmpegPath) {
        const audioPath = path.join(workDir, 'audio.mp3');
        try {
          await execFileAsync(ffmpegPath, [
            '-i', mediaFilePath,
            '-vn',
            '-acodec', 'libmp3lame',
            '-ar', '16000',
            '-ac', '1',
            '-b:a', '64k',
            '-y',
            audioPath
          ]);

          if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
            const audioStream = fs.createReadStream(audioPath);
            const transcription: any = await this.openai.audio.transcriptions.create({
              file: audioStream,
              model: this.transcriptionModel,
              response_format: 'verbose_json'
            });

            transcript = transcription.text || '';
            if (Array.isArray(transcription.segments)) {
              for (const seg of transcription.segments) {
                transcriptSegments.push({
                  start: seg.start,
                  end: seg.end,
                  text: seg.text.trim()
                });
              }
            }
          }
        } catch (audioErr) {
          console.warn('[OpenAiExtractor] Audio transcription skipped/failed:', audioErr);
        } finally {
          if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
          }
        }

        // 2. Video Frame Sampling (PRD §9.3 Stage 5: Sample 1 frame every 3-4s, max 8 frames)
        try {
          const framePattern = path.join(workDir, 'frame_%03d.jpg');
          await execFileAsync(ffmpegPath, [
            '-i', mediaFilePath,
            '-vf', 'fps=1/4,scale=720:-1',
            '-vframes', '8',
            '-q:v', '3',
            '-y',
            framePattern
          ]);

          const files = fs.readdirSync(workDir).filter(f => f.startsWith('frame_') && f.endsWith('.jpg')).sort();
          for (let i = 0; i < files.length; i++) {
            const fPath = path.join(workDir, files[i]);
            const base64 = fs.readFileSync(fPath).toString('base64');
            sampledFramesBase64.push({
              timeSec: (i + 1) * 4,
              base64
            });
            fs.unlinkSync(fPath); // cleanup
          }
        } catch (frameErr) {
          console.warn('[OpenAiExtractor] Video frame sampling skipped:', frameErr);
        }
      }

      // 3. Multimodal Synthesis
      const content: any[] = [
        {
          type: 'text',
          text: `You are analyzing a travel video (TikTok/Reel) for a trip to ${destinationContext}.
  Caption: ${metadata.caption || 'None'}
  Speech Transcript:
  ${transcript || 'No speech recorded'}

  Transcript Segments with Timestamps:
  ${JSON.stringify(transcriptSegments.slice(0, 30))}

  Attached are sampled frames from the video.
  Extract every real physical place, venue, restaurant, coffee shop, or landmark.
  Provide exact timestamps in evidence for where the venue is spoken or shown in frames.
  Strictly return JSON conforming to the structured extraction schema.`
        }
      ];

      for (const frame of sampledFramesBase64) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${frame.base64}`,
            detail: 'low'
          }
        });
      }

      try {
        const response = await this.openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          temperature: 0.2
        });

        const rawJson = response.choices[0]?.message?.content || '{}';
        return sanitize(JSON.parse(rawJson), metadata.caption || 'Uploaded video');
      } catch (err) {
        console.error('[OpenAiExtractor] Multimodal extraction failed:', err);
        throw new Error(describeAiError(err));
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
