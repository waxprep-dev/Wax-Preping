import axios from 'axios';
import type { PedagogicalIntent } from '../types/student';
import { logger } from '../middleware/logger';

export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<Buffer> {
  // Get media URL from WhatsApp
  const urlResponse = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const mediaUrl = urlResponse.data.url;

  // Download the actual media
  const mediaResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return Buffer.from(mediaResponse.data);
}

export async function encodeImageMessage(
  imageBuffer: Buffer,
  rawCaption?: string
): Promise<PedagogicalIntent> {
  // We use GPT-4V via OpenAI or fallback to describing what we can
  const apiKey = process.env.OPENAI_API_KEY;

  let visionAnalysis = {
    problemDescription: '',
    studentWork: '',
    errorType: '',
    subject: '',
    topic: '',
    hasAttempt: false,
  };

  if (apiKey) {
    try {
      const base64Image = imageBuffer.toString('base64');
      const mimeType = 'image/jpeg';

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:${mimeType};base64,${base64Image}` },
                },
                {
                  type: 'text',
                  text: `Analyze this image from a Nigerian student. Extract: 
1. What math/science problem is shown? Describe it precisely.
2. What work has the student already done? What did they write?
3. If there is an error, what type of error is it? (Do NOT solve it)
4. What subject and topic is this? (e.g., "Mathematics - Quadratic Equations")
5. Does the student have a partial attempt?
Respond in JSON: { "problemDescription": "", "studentWork": "", "errorType": "", "subject": "", "topic": "", "hasAttempt": boolean }`,
                },
              ],
            },
          ],
          max_tokens: 500,
        },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );

      const content = response.data.choices[0]?.message?.content ?? '';
      const cleanJson = content.replace(/```json|```/g, '').trim();
      visionAnalysis = JSON.parse(cleanJson);
    } catch (err) {
      logger.warn('[ImageEncoder] Vision API failed:', err);
    }
  }

  return {
    primaryIntent: 'expressing_confusion',
    hasMisconception: visionAnalysis.errorType.length > 0,
    misconceptionDescription: visionAnalysis.errorType || undefined,
    inferredKnowledgeLevel: visionAnalysis.hasAttempt ? 0.4 : 0.3,
    inferredTopic: visionAnalysis.topic || undefined,
    inferredSubject: visionAnalysis.subject || undefined,
    temporalPressure: 'none',
    rawMessage: rawCaption || visionAnalysis.problemDescription || 'Student sent a math/science problem image',
    emotionalSignals: {
      valence: 0.5, arousal: 0.5, dominance: 0.4,
      shamePotential: 0.4, curiosity: 0.5, selfEfficacy: 0.4,
      flowIndicator: 0.2, frustration: 0.3, tiredness: 0.1, excitement: 0.3,
    },
    messageLength: rawCaption?.length || 50,
    containsQuestion: true,
    languageStyle: 'mixed',
    isRepeatedQuestion: false,
    repetitionCount: 0,
    // Attach vision analysis for use in prompt
    ...(visionAnalysis.problemDescription ? { _visionContext: visionAnalysis } : {}),
  } as PedagogicalIntent & { _visionContext?: typeof visionAnalysis };
}