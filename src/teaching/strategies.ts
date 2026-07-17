/**
 * Subject pedagogy knowledge base.
 *
 * This is DATA, not behavior: it informs the deliberation prompt (which
 * subjects' typical misconceptions to watch for, which analogy domains fit),
 * while the actual strategy choice is made by the deliberation LLM call from
 * the student's live state — nothing here scripts the conversation.
 *
 * Stored in system_config (key: subject_pedagogy) so it can be extended
 * without a deploy; the in-code copy is the fallback.
 */
import { db } from '../db/client';

export interface SubjectPedagogy {
  focus: string;
  analogyDomains: string[];
  watchFor: string[];
  format: string;
}

const DEFAULT_PEDAGOGY: Record<string, SubjectPedagogy> = {
  mathematics: {
    focus: 'Show WHY before HOW. Concrete before abstract. Never skip steps.',
    analogyDomains: ['market trading', 'sharing food or money', 'measuring farm plots', 'phone data bundles', 'keke fares'],
    watchFor: ['multiplication always makes bigger', 'negative number confusion', 'BODMAS errors', 'fraction misconceptions', 'x means nothing in particular'],
    format: 'Intuition → Formula → Worked example → Student tries parallel problem',
  },
  physics: {
    focus: 'Start with an observable phenomenon. Model it. Connect to daily life.',
    analogyDomains: ['NEPA/generators', 'danfo buses', 'phone charging', 'cooking fire', 'water in buckets and pipes'],
    watchFor: ['heavier objects fall faster', 'force needed to keep motion going', 'current used up in a bulb', 'heat as a substance'],
    format: 'Observable → Physical model → Equation → Exam-style application',
  },
  chemistry: {
    focus: 'Particulate models before equations. Reactions as rearrangements, not magic.',
    analogyDomains: ['cooking', 'soap making', 'palm wine fermentation', 'dyeing fabrics', 'phone batteries'],
    watchFor: ['atoms as solid balls', 'bonds as physical sticks', 'mass disappears in reactions', 'electronegativity vs electron affinity'],
    format: 'Macro observation → Particulate model → Equation → Calculation',
  },
  biology: {
    focus: 'Use local organisms. Connect to health, farming, ecosystems the student knows.',
    analogyDomains: ['cassava and yam farming', 'family traits', 'malaria', 'goats and poultry', 'local plants'],
    watchFor: ['plants get food from soil', 'evolution has a purpose', 'antibiotics kill viruses', 'osmosis direction'],
    format: 'Observable organism → Structure → Function → Local application',
  },
  english: {
    focus: 'Connect grammar to real communication patterns the student already uses.',
    analogyDomains: ['market conversation', 'WhatsApp messages', 'news broadcasts', 'song lyrics'],
    watchFor: ['direct Pidgin translation errors', 'tense confusion', 'article usage', 'sentence structure transferred from local language'],
    format: 'Rule → Why it exists → Common error → Correct example → Student rewrites',
  },
  economics: {
    focus: 'Use market and business reality. Connect macro concepts to everyday transactions.',
    analogyDomains: ['Lagos market', 'naira exchange rate', 'fuel scarcity queues', 'petty trading', 'artisan pricing'],
    watchFor: ['supply/demand direction', 'GDP vs GDP per capita', 'inflation direction', 'opportunity cost as money cost only'],
    format: 'Local example → Economic principle → Graph/model → Exam application',
  },
  general: {
    focus: 'Be clear, patient, and concrete. Build from what the student already knows.',
    analogyDomains: ['daily life', 'market and business', 'family and community', 'football', 'music'],
    watchFor: ['surface memorization without understanding'],
    format: 'Concept → Example → Student applies',
  },
};

export async function getSubjectPedagogy(subject: string): Promise<SubjectPedagogy> {
  let table = DEFAULT_PEDAGOGY;
  try {
    const result = await db.query(`SELECT content FROM system_config WHERE key = 'subject_pedagogy' LIMIT 1`);
    if (result.rows.length > 0) {
      table = JSON.parse(result.rows[0].content) as Record<string, SubjectPedagogy>;
    } else {
      await db.query(
        `INSERT INTO system_config (key, content) VALUES ('subject_pedagogy', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify(DEFAULT_PEDAGOGY)]
      );
    }
  } catch { /* fallback to defaults */ }

  return table[subject.toLowerCase()] || table.general || DEFAULT_PEDAGOGY.general;
}

export function formatSubjectContext(pedagogy: SubjectPedagogy, subject: string, topic: string | null, knowledgeLevel: number): string {
  const level = knowledgeLevel < 0.3 ? 'beginner — build from absolute basics'
    : knowledgeLevel < 0.6 ? 'intermediate — some foundation, can use subject vocabulary'
    : 'advanced — can handle complexity, connect concepts';

  return `SUBJECT: ${subject.toUpperCase()}${topic ? ` (${topic})` : ''} | Level: ${level}
Focus: ${pedagogy.focus}
Good analogy domains: ${pedagogy.analogyDomains.join(', ')}
Known misconceptions to watch for: ${pedagogy.watchFor.join('; ')}
Teaching arc: ${pedagogy.format}`;
}
