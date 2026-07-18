/**
 * WhatsApp Cloud API webhook.
 *
 * v3.0: Added typing indicator before long operations. Onboarding is handled
 * inside the crew pipeline, so the webhook remains thin.
 */
import express, { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { processTutorMessage } from '../agents/crew';
import { sendTextMessage, markAsRead, sendTypingIndicator } from './sender';
import { isMessageProcessed, markMessageProcessed, updateLastSeen } from '../session/manager';
import { logger } from '../middleware/logger';
import { checkRateLimit } from '../middleware/rate_limiter';

export function createWebhookRouter(): Router {
  const router = express.Router();

  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('[Webhook] Verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  router.post('/webhook', async (req: Request, res: Response) => {
    res.sendStatus(200);

    if (process.env.WHATSAPP_APP_SECRET) {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) {
        logger.warn('[Webhook] Missing X-Hub-Signature-256 header');
        return;
      }
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
      const expected = `sha256=${crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
      const expectedBuf = Buffer.from(expected);
      const signatureBuf = Buffer.from(signature);
      if (expectedBuf.length !== signatureBuf.length || !crypto.timingSafeEqual(expectedBuf, signatureBuf)) {
        logger.warn('[Webhook] Invalid signature');
        return;
      }
    }

    setImmediate(() => {
      processPayload(req.body).catch(err => logger.error({ err }, '[Webhook] Async error'));
    });
  });

  return router;
}

async function processPayload(body: Record<string, unknown>): Promise<void> {
  const entries = (body.entry as Record<string, unknown>[]) ?? [];

  for (const entry of entries) {
    const changes = (entry.changes as Record<string, unknown>[]) ?? [];
    for (const change of changes) {
      const value = change.value as Record<string, unknown>;
      const messages = (value.messages as Record<string, unknown>[]) ?? [];
      const phoneNumberId = (value.metadata as Record<string, unknown>)?.phone_number_id as string;

      for (const message of messages) {
        await handleMessage(message, phoneNumberId).catch(err =>
          logger.error({ err }, '[Webhook] Message error')
        );
      }
    }
  }
}

async function handleMessage(message: Record<string, unknown>, phoneNumberId: string): Promise<void> {
  const messageId = message.id as string;
  const studentId = message.from as string;
  const messageType = message.type as string;

  if (await isMessageProcessed(messageId)) return;
  await markMessageProcessed(messageId);
  await updateLastSeen(studentId);

  if (phoneNumberId) await markAsRead(phoneNumberId, messageId);

  const rateCheck = await checkRateLimit(`student:${studentId}`, 30, 3600);
  if (!rateCheck.allowed) {
    if (phoneNumberId) await sendTextMessage(phoneNumberId, studentId, 'Slow down small! Take a moment to review what we discussed. You can send more in an hour.');
    return;
  }

  const unsupported: Record<string, string> = {
    video: "I can see you sent a video — I can't watch it yet. Can you describe it or type your question?",
    sticker: 'Nice sticker! What are you studying today?',
    contacts: 'I see you shared a contact. What topic are you working on?',
    location: 'I see your location. What topic are you studying?',
  };

  if (unsupported[messageType]) {
    if (phoneNumberId) await sendTextMessage(phoneNumberId, studentId, unsupported[messageType]);
    return;
  }

  if (!['text', 'image', 'audio', 'document'].includes(messageType)) {
    if (phoneNumberId) await sendTextMessage(phoneNumberId, studentId, "I got your message but can't process this format. Try text, a photo, or a voice note!");
    return;
  }

  let rawMessage = '';
  let mediaId: string | undefined;
  let mediaCaption: string | undefined;

  if (messageType === 'text') {
    rawMessage = (message.text as Record<string, unknown>)?.body as string ?? '';
  } else if (messageType === 'image') {
    const img = message.image as Record<string, unknown>;
    mediaId = img?.id as string;
    mediaCaption = img?.caption as string;
    rawMessage = mediaCaption || 'Student sent an image';
  } else if (messageType === 'audio') {
    const audio = message.audio as Record<string, unknown>;
    mediaId = audio?.id as string;
    rawMessage = 'Voice note';
  } else if (messageType === 'document') {
    const doc = message.document as Record<string, unknown>;
    mediaId = doc?.id as string;
    mediaCaption = doc?.caption as string;
    rawMessage = mediaCaption || 'Student sent a document';
  }

  if (!rawMessage.trim() && !mediaId) return;

  try {
    // v3.0: Send typing indicator before potentially long processing
    if (phoneNumberId) {
      await sendTypingIndicator(phoneNumberId, studentId).catch(() => {});
    }

    const responseText = await processTutorMessage({
      studentId, rawMessage, messageId,
      modality: messageType as 'text' | 'image' | 'audio' | 'document' | 'video',
      mediaId, mediaCaption,
    });

    if (phoneNumberId && responseText) {
      await sendTextMessage(phoneNumberId, studentId, responseText);
    }
  } catch (err) {
    logger.error({ err }, '[Webhook] Processing failed');
    if (phoneNumberId) {
      await sendTextMessage(phoneNumberId, studentId, "Something went wrong on my end. Give me a moment and try again — I'm still here.");
    }
  }
}