import axios from 'axios';
import FormData from 'form-data';
import type { PedagogicalIntent } from '../types/student';
import { encodeTextMessage } from './text';
import { logger } from '../middleware/logger';

interface ParalinguisticFeatures {
  estimatedTremor: number;
  estimatedPace: 'fast' | 'normal' | 'slow';
  confidence: number;
  anxiety: number;
}

function estimateParalinguistics(audioDurationMs: number, transcriptLength: number): ParalinguisticFeatures {
  // Approximate words per minute from transcript length and duration
  const wordsPerMinute = transcriptLength > 0 && audioDurationMs > 0
    ? (transcriptLength / 5 / (audioDurationMs / 60000))
    : 120;

  const pace: ParalinguisticFeatures['pace'] =
    wordsPerMinute > 160 ? 'fast' : wordsPerMinute < 90 ? 'slow' : 'normal';

  // Anxiety correlates with fast pace and short transcript (meaning lots of silence/pauses)
  const anxiety = wordsPerMinute > 170 ? 0.7 : wordsPerMinute < 80 ? 0.6 : 0.3;

  return {
    estimatedTremor: anxiety * 0.8,
    estimatedPace: pace,
    confidence: pace === 'normal' ? 0.6 : 0.4,
    anxiety,
  };
}

export async function transcribeVoiceNote(
  audioBuffer: Buffer,
  audioDurationMs = 5000
): Promise<{ transcript: string; paralinguistics: ParalinguisticFeatures }> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('[VoiceEncoder] No OpenAI key — returning placeholder');
    return {
      transcript: 'Voice note received but could not be transcribed',
      paralinguistics: { estimatedTremor: 0.3, estimatedPace: 'normal', confidence: 0.5, anxiety: 0.3 },
    };
  }

  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');
    formData.append('response_format', 'verbose_json');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30_000,
      }
    );

    const transcript = response.data.text ?? '';
    const paralinguistics = estimateParalinguistics(audioDurationMs, transcript.length);

    return { transcript, paralinguistics };
  } catch (err) {
    logger.error('[VoiceEncoder] Whisper transcription failed:', err);
    return {
      transcript: 'Could not understand voice note — please type your question',
      paralinguistics: { estimatedTremor: 0.3, estimatedPace: 'normal', confidence: 0.5, anxiety: 0.3 },
    };
  }
}

export async function encodeVoiceMessage(
  audioBuffer: Buffer,
  audioDurationMs = 5000
): Promise<PedagogicalIntent> {
  const { transcript, paralinguistics } = await transcribeVoiceNote(audioBuffer, audioDurationMs);

  const textIntent = encodeTextMessage(transcript);

  // Boost shame detection if paralinguistics suggest anxiety/tremor
  const shamePotential = Math.min(1.0,
    textIntent.emotionalSignals.shamePotential +
    paralinguistics.estimatedTremor * 0.3 +
    paralinguistics.anxiety * 0.2
  );

  return {
    ...textIntent,
    rawMessage: transcript,
    emotionalSignals: {
      ...textIntent.emotionalSignals,
      shamePotential,
      arousal: Math.min(1, textIntent.emotionalSignals.arousal + paralinguistics.anxiety * 0.2),
    },
  };
}

export async function generateVoiceResponse(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.6, similarity_boost: 0.8 },
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 20_000,
      }
    );

    return Buffer.from(response.data);
  } catch (err) {
    logger.warn('[VoiceEncoder] TTS failed:', err);
    return null;
  }
}