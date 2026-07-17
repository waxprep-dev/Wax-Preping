/**
 * Embedding service with provider tagging.
 *
 * v1 bug fixed: when the HuggingFace key was missing, a deterministic
 * character-hash "embedding" was silently substituted, and those vectors were
 * stored in the SAME column as real MiniLM vectors. Cosine search over a
 * mixed space returns garbage. v2 tags every vector with its provider and
 * recall only searches within the query's own provider space.
 */
import axios from 'axios';
import { logger } from '../middleware/logger';

const EMBEDDING_DIM = 384;

export interface EmbeddingResult {
  vector: number[];
  provider: 'minilm' | 'fallback';
}

export async function embed(text: string): Promise<EmbeddingResult> {
  const hfKey = process.env.HF_API_KEY;

  if (hfKey) {
    try {
      const response = await axios.post(
        'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2',
        { inputs: text.slice(0, 512), options: { wait_for_model: true } },
        { headers: { Authorization: `Bearer ${hfKey}` }, timeout: 15_000 }
      );

      const data = response.data;
      if (Array.isArray(data) && Array.isArray(data[0])) return { vector: data[0] as number[], provider: 'minilm' };
      if (Array.isArray(data) && typeof data[0] === 'number') return { vector: data as number[], provider: 'minilm' };
    } catch {
      logger.debug('[Embeddings] HuggingFace failed — using deterministic fallback');
    }
  }

  return { vector: deterministicEmbed(text), provider: 'fallback' };
}

function deterministicEmbed(text: string): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0) as number[];
  const normalized = text.toLowerCase().trim();

  for (let i = 0; i < normalized.length && i < 1000; i++) {
    const charCode = normalized.charCodeAt(i);
    const positions = [
      i % EMBEDDING_DIM,
      (i * 3) % EMBEDDING_DIM,
      (i * 7 + charCode) % EMBEDDING_DIM,
    ];
    for (const pos of positions) {
      vector[pos] = (vector[pos] + Math.sin(charCode * (pos + 1))) / 2;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => v / magnitude);
}
