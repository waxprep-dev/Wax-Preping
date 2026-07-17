/**
 * Image modality: download from WhatsApp, analyze with a vision model,
 * return a structured description that the perception fusion pass consumes.
 *
 * v1 bug fixed: the vision analysis was stuffed into `_visionContext` and then
 * silently dropped — the swarm never read it, so a photo of a student's
 * worked solution reached the tutor as "Student sent an image". In v2 the
 * vision context is a first-class input to deliberation.
 */
import axios from 'axios';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';

export interface VisionAnalysis {
  problemDescription: string;
  studentWork: string;
  errorType: string;
  subject: string;
  topic: string;
  hasAttempt: boolean;
}

export async function downloadWhatsAppMedia(mediaId: string, accessToken: string): Promise<Buffer> {
  const urlResponse = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const mediaUrl = urlResponse.data.url;
  const mediaResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return Buffer.from(mediaResponse.data);
}

export async function analyzeImage(imageBuffer: Buffer, rawCaption?: string): Promise<VisionAnalysis> {
  const fallback: VisionAnalysis = {
    problemDescription: rawCaption || 'Image received (analysis unavailable)',
    studentWork: '',
    errorType: '',
    subject: '',
    topic: '',
    hasAttempt: false,
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;

  try {
    const base64 = imageBuffer.toString('base64');
    const instruction = await getPrompt('vision_analysis.v1');
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: instruction },
          ],
        }],
        max_tokens: 400,
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30_000 }
    );

    const content = response.data.choices[0]?.message?.content || '';
    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
    return { ...fallback, ...parsed };
  } catch (err) {
    logger.warn({ err }, '[ImagePerception] Vision analysis failed');
    return fallback;
  }
}
