import axios from 'axios';
import { logger } from '../middleware/logger';

const WA_BASE = 'https://graph.facebook.com/v20.0';

function headers() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
}

export async function sendTextMessage(phoneNumberId: string, to: string, text: string): Promise<string> {
  const chunks = chunkText(text, 4000);
  let lastId = '';

  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = await axios.post(
        `${WA_BASE}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: chunks[i], preview_url: false } },
        { headers: headers(), timeout: 15_000 }
      );
      lastId = response.data?.messages?.[0]?.id ?? '';
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      logger.error('[Sender] Send failed:');
    }
  }

  return lastId;
}

export async function markAsRead(phoneNumberId: string, messageId: string): Promise<void> {
  try {
    await axios.post(
      `${WA_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: headers(), timeout: 5_000 }
    );
  } catch { /* not critical */ }
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let split = maxLen;
    const period = remaining.lastIndexOf('. ', maxLen);
    const newline = remaining.lastIndexOf('\n', maxLen);
    if (period > maxLen * 0.6) split = period + 2;
    else if (newline > maxLen * 0.6) split = newline + 1;
    chunks.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}