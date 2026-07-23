/**
 * Perception layer — the system's senses.
 *
 * Pipeline: modality preprocessor (text features / vision / whisper / pdf)
 * -> ONE fast-tier LLM fusion call -> PerceptionResult.
 *
 * This replaces v1's encoders + swarm router + chain stage 1&2 (four separate
 * mechanisms producing mostly-hardcoded or mutually-inconsistent reads) with
 * a single structured perception that downstream layers can trust. If the
 * fusion call fails, deterministic fallbacks keep the turn alive.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';
import { clamp01 } from '../utils/math';
import { extractTextFeatures } from './text';
import { analyzeImage, downloadWhatsAppMedia } from './image';
import { transcribeVoice } from './voice';
import { analyzeDocument } from './document';
import type { EmotionalSnapshot } from '../types/student';
import type { PerceptionResult } from '../types/teaching';

export interface IncomingMedia {
  type: 'text' | 'image' | 'audio' | 'video' | 'document';
  text?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

const NEUTRAL_EMOTION: EmotionalSnapshot & { dominantEmotion: string } = {
  valence: 0.6, arousal: 0.4, dominance: 0.5,
  shamePotential: 0.2, curiosity: 0.5, selfEfficacy: 0.5,
  flowIndicator: 0.3, frustration: 0.2, tiredness: 0.1, excitement: 0.3,
  dominantEmotion: 'neutral',
};

export async function perceive(
  media: IncomingMedia,
  messageHistory: string[] = [],
  studentId?: string
): Promise<PerceptionResult> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';

  // ── Stage 1: modality preprocessing ─────────────────────────────────────
  let effectiveText = media.text || '';
  let modality: string = media.type;
  let visionContext: Record<string, unknown> | undefined;
  let documentContext: Record<string, unknown> | undefined;
  let modalityNote = '';

  if (media.type === 'image' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const vision = await analyzeImage(buffer, media.caption);
      visionContext = vision as unknown as Record<string, unknown>;
      effectiveText = [
        media.caption ? `Caption: "${media.caption}"` : '',
        `Image shows: ${vision.problemDescription}`,
        vision.studentWork ? `Student's written work: ${vision.studentWork}` : '',
        vision.errorType ? `Visible error: ${vision.errorType}` : '',
      ].filter(Boolean).join('\n');
      modalityNote = 'Student sent a photo — likely of schoolwork. Treat the image analysis as their message.';
    } catch (err) {
      logger.warn({ err }, '[Perception] Image pipeline failed');
      effectiveText = media.caption || 'Student sent an image';
      modality = 'text';
    }
  } else if (media.type === 'audio' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const voice = await transcribeVoice(buffer);
      effectiveText = voice.transcript;
      modality = 'voice';
      modalityNote = 'Student spoke a voice note. Spoken language is often less structured — read intent generously.';
    } catch (err) {
      logger.warn({ err }, '[Perception] Voice pipeline failed');
      effectiveText = 'Student sent a voice note';
      modality = 'text';
    }
  } else if (media.type === 'document' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const doc = await analyzeDocument(buffer, media.filename);
      documentContext = { examBoard: doc.examBoard, subject: doc.subject, topics: doc.topics, difficulty: doc.difficulty, summary: doc.summary };
      effectiveText = [
        media.caption ? `Caption: "${media.caption}"` : '',
        `Document summary: ${doc.summary}`,
        doc.topics.length > 0 ? `Topics found: ${doc.topics.join(', ')}` : '',
        doc.rawText ? `Extract:\n${doc.rawText.slice(0, 1500)}` : '',
      ].filter(Boolean).join('\n');
      modalityNote = 'Student sent a document — probably past questions or notes.';
    } catch (err) {
      logger.warn({ err }, '[Perception] Document pipeline failed');
      effectiveText = media.caption || 'Student sent a document';
      modality = 'text';
    }
  }

  const features = extractTextFeatures(effectiveText, messageHistory);

  // ── Stage 2: LLM fusion ─────────────────────────────────────────────────
  const fallback: PerceptionResult = {
    rawMessage: effectiveText,
    modality,
    primaryIntent: features.containsQuestion ? 'asking_explanation' : 'other',
    inferredTopic: null,
    inferredSubject: null,
    hasMisconception: false,
    misconceptionDescription: null,
    emotionalSignals: { ...NEUTRAL_EMOTION },
    urgency: 'normal',
    cognitiveLoad: 'medium',
    masterySignal: 'none',
    languageStyle: 'mixed',
    temporalPressure: 'none',
    isRepeatedQuestion: features.isRepeatedQuestion,
    repetitionCount: features.repetitionCount,
    visionContext,
    documentContext,
  };

  try {
    const instruction = await getPrompt('perception.v1');
    const historyNote = messageHistory.length > 0
      ? `Recent student messages: ${messageHistory.slice(-3).map(m => `"${m.slice(0, 80)}"`).join(' | ')}`
      : 'No prior messages (possibly a brand-new student).';

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          `Student message: "${effectiveText.slice(0, 1200)}"`,
          modalityNote,
          historyNote,
          features.isRepeatedQuestion ? `NOTE: student has sent this exact message ${features.repetitionCount + 1} times.` : '',
        ].filter(Boolean).join('\n'),
      },
    ], { tier: 'fast', jsonMode: true, maxTokens: 450, temperature: 0.2, studentId, purpose: 'perception' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    const es = parsed.emotionalSignals || {};

    return {
      ...fallback,
      primaryIntent: parsed.primaryIntent || fallback.primaryIntent,
      inferredTopic: parsed.inferredTopic || null,
      inferredSubject: parsed.inferredSubject || null,
      hasMisconception: parsed.hasMisconception === true,
      misconceptionDescription: parsed.misconceptionDescription || null,
      emotionalSignals: {
        valence: clamp01(es.valence, 0.6),
        arousal: clamp01(es.arousal, 0.4),
        dominance: clamp01(es.dominance, 0.5),
        shamePotential: clamp01(es.shamePotential, 0.2),
        curiosity: clamp01(es.curiosity, 0.5),
        selfEfficacy: clamp01(es.selfEfficacy, 0.5),
        flowIndicator: clamp01(es.flowIndicator, 0.3),
        frustration: clamp01(es.frustration, 0.2),
        tiredness: clamp01(es.tiredness, 0.1),
        excitement: clamp01(es.excitement, 0.3),
        dominantEmotion: es.dominantEmotion || 'neutral',
      },
      urgency: parsed.urgency || 'normal',
      cognitiveLoad: parsed.cognitiveLoad || 'medium',
      masterySignal: parsed.masterySignal || 'none',
      languageStyle: parsed.languageStyle || 'mixed',
      temporalPressure: parsed.temporalPressure || 'none',
    };
  } catch (err) {
    logger.warn({ err }, '[Perception] Fusion failed — using heuristic fallback');
    return fallback;
  }
}