/**
 * Voice modality: transcribe with Whisper. Paralinguistic estimation is now
 * derived from transcript evidence by the perception fusion pass instead of
 * v1's fabricated constants (tremor 0.3, anxiety 0.3 for everyone).
 */
import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../middleware/logger';

export interface VoiceTranscription {
  transcript: string;
  transcribed: boolean;
}

export async function transcribeVoice(audioBuffer: Buffer): Promise<VoiceTranscription> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { transcript: 'Student sent a voice note (transcription unavailable)', transcribed: false };

  try {
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'en');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
      timeout: 30_000,
    });

    const transcript = (response.data.text as string) || '';
    return transcript.trim().length > 0
      ? { transcript, transcribed: true }
      : { transcript: 'Student sent a voice note (empty transcription)', transcribed: false };
  } catch (err) {
    logger.warn({ err }, '[VoicePerception] Whisper failed');
    return { transcript: 'Student sent a voice note (transcription failed)', transcribed: false };
  }
}
