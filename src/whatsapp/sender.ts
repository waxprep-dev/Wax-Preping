// WhatsApp sender — the outbound side.
// Sends responses back to the student via WhatsApp Cloud API.
// Handles the typing indicator and message chunking for long responses.

import axios from "axios";

const WA_API_BASE = "https://graph.facebook.com/v20.0";

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// Show "typing..." indicator before the response
export async function sendTypingIndicator(phoneNumberId: string, toNumber: string): Promise<void> {
  try {
    await axios.post(
      `${WA_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: toNumber,
        type: "reaction",
        reaction: {
          message_id: "fake_id", // WhatsApp doesn't have a real typing API — this is a workaround
          emoji: "💭",
        },
      },
      { headers: getHeaders() }
    );
  } catch {
    // Typing indicator is not critical — fail silently
  }
}

// Send a text message to a WhatsApp number
export async function sendTextMessage(
  phoneNumberId: string,
  toNumber: string,
  text: string
): Promise<{ messageId: string }> {
  // WhatsApp has a 4096 character limit per message
  // If the response is longer, split it into chunks
  const chunks = chunkMessage(text, 4000);

  let lastMessageId = "";

  for (const chunk of chunks) {
    const response = await axios.post(
      `${WA_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toNumber,
        type: "text",
        text: {
          body: chunk,
          preview_url: false,
        },
      },
      { headers: getHeaders() }
    );

    lastMessageId = response.data?.messages?.[0]?.id ?? "";

    // Brief pause between chunks to maintain reading flow
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { messageId: lastMessageId };
}

// Mark a message as read (shows blue ticks to the student)
export async function markAsRead(
  phoneNumberId: string,
  messageId: string
): Promise<void> {
  try {
    await axios.post(
      `${WA_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      },
      { headers: getHeaders() }
    );
  } catch {
    // Not critical — fail silently
  }
}

// Split long text into chunks that respect sentence boundaries
function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a sentence boundary
    let splitPoint = maxLength;
    const lastPeriod = remaining.lastIndexOf(". ", maxLength);
    const lastNewline = remaining.lastIndexOf("\n", maxLength);

    if (lastPeriod > maxLength * 0.6) {
      splitPoint = lastPeriod + 2;
    } else if (lastNewline > maxLength * 0.6) {
      splitPoint = lastNewline + 1;
    }

    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}