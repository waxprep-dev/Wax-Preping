/**
 * Text modality pre-processor. Produces the deterministic parts of perception
 * (length, question marks, repetition) — the interpretive parts are done by
 * the LLM fusion pass in perception/index.ts, not by hardcoded scores
 * (v1 hardcoded every emotional signal to ~0.5, making them noise).
 */
export interface TextFeatures {
  rawMessage: string;
  messageLength: number;
  containsQuestion: boolean;
  isRepeatedQuestion: boolean;
  repetitionCount: number;
}

export function extractTextFeatures(rawMessage: string, messageHistory: string[] = []): TextFeatures {
  const normalized = rawMessage.trim().toLowerCase();
  const priorOccurrences = normalized.length > 0
    ? messageHistory.filter(m => m.trim().toLowerCase() === normalized).length
    : 0;

  return {
    rawMessage,
    messageLength: rawMessage.length,
    containsQuestion: rawMessage.includes('?'),
    isRepeatedQuestion: priorOccurrences >= 1,
    repetitionCount: priorOccurrences,
  };
}
