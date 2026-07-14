import type { PedagogicalIntent } from '../types/student';
import { encodeTextMessage } from './text';
import { encodeImageMessage, downloadWhatsAppMedia } from './image';
import { encodeVoiceMessage } from './voice';
import { encodeDocumentMessage } from './document';
import { logger } from '../middleware/logger';

export interface IncomingMedia {
  type: 'text' | 'image' | 'audio' | 'video' | 'document';
  text?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

export async function routeAndEncode(
  media: IncomingMedia,
  messageHistory: string[] = [],
  repetitionCount = 0
): Promise<{ intent: PedagogicalIntent; modality: string }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';

  if (media.type === 'text') {
    return {
      intent: encodeTextMessage(media.text || '', messageHistory, repetitionCount),
      modality: 'text',
    };
  }

  if (media.type === 'image' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const intent = await encodeImageMessage(buffer, media.caption);
      return { intent, modality: 'image' };
    } catch (err) {
      logger.error('[EncoderRouter] Image encoding failed:', err);
      return {
        intent: encodeTextMessage(media.caption || 'Student sent an image', messageHistory),
        modality: 'text',
      };
    }
  }

  if (media.type === 'audio' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const intent = await encodeVoiceMessage(buffer);
      return { intent, modality: 'voice' };
    } catch (err) {
      logger.error('[EncoderRouter] Voice encoding failed:', err);
      return {
        intent: encodeTextMessage('Student sent a voice note', messageHistory),
        modality: 'text',
      };
    }
  }

  if (media.type === 'document' && media.mediaId) {
    try {
      const buffer = await downloadWhatsAppMedia(media.mediaId, accessToken);
      const { intent } = await encodeDocumentMessage(buffer, media.filename);
      return { intent, modality: 'document' };
    } catch (err) {
      logger.error('[EncoderRouter] Document encoding failed:', err);
      return {
        intent: encodeTextMessage('Student sent a document', messageHistory),
        modality: 'text',
      };
    }
  }

  // Fallback for video or unknown types
  return {
    intent: encodeTextMessage(media.caption || media.text || 'Student sent media', messageHistory),
    modality: media.type,
  };
}