/**
 * Subject pedagogy — configuration-driven, no hardcoded subject enums.
 *
 * Pedagogy is loaded from system_config (key = pedagogy_<subject_slug>).
 * If missing, a generic template is returned. Subjects are discovered from
 * student utterances and syllabus store — never from a code-level list.
 *
 * seedDefaultPedagogies() intentionally seeds ZERO named subjects.
 * Admins / sleep-mode / LLM jobs may write pedagogy_* rows dynamically.
 */
import { db } from '../db/client';
import { logger } from '../middleware/logger';

export interface SubjectPedagogy {
  subject: string;
  commonMisconceptions: string[];
  analogyDomains: string[];
  localContext: string;
  examTips: string;
  bloomScaffolds: Record<string, string>;
}

const GENERIC_PEDAGOGY: SubjectPedagogy = {
  subject: 'general',
  commonMisconceptions: [
    'Confusing memorization with understanding',
    'Applying formulas without understanding their derivation',
    'Ignoring units or definitions in calculations',
    'Mixing up similar-sounding concepts',
  ],
  analogyDomains: [
    'everyday life',
    'sports',
    'cooking',
    'farming',
    'market trading',
    'music',
  ],
  localContext:
    'Adapt to the student\'s discovered exam targets, school level, and cultural context. Never assume a specific exam board.',
  examTips:
    'Prefer application over rote recall. Show working. Connect answers to the student\'s stated goals when known.',
  bloomScaffolds: {
    remember: 'Define and identify',
    understand: 'Explain in your own words',
    apply: 'Solve a similar problem',
    analyze: 'Compare and contrast',
    evaluate: 'Judge which approach is better',
    create: 'Design a new solution',
  },
};

function slugSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Load pedagogy for a subject from system_config.
 * If not found, returns generic pedagogy (never invents a subject enum).
 */
export async function getSubjectPedagogy(
  subject: string | null | undefined
): Promise<SubjectPedagogy> {
  if (!subject || subject === 'general') return { ...GENERIC_PEDAGOGY };

  const key = `pedagogy_${slugSubject(subject)}`;
  try {
    const result = await db.query(
      `SELECT content FROM system_config WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (result.rows.length > 0) {
      const content =
        typeof result.rows[0].content === 'string'
          ? JSON.parse(result.rows[0].content)
          : result.rows[0].content;
      return {
        ...GENERIC_PEDAGOGY,
        ...content,
        subject: content.subject || subject,
      };
    }
  } catch (err) {
    logger.debug({ err, subject }, '[Pedagogy] load failed — using generic');
  }

  // Return generic template labeled with the discovered subject name
  return {
    ...GENERIC_PEDAGOGY,
    subject,
    localContext: `Subject context is being discovered dynamically for "${subject}". Use student attributes and syllabus reference; do not assume exam boards.`,
  };
}

export function formatSubjectContext(
  pedagogy: SubjectPedagogy,
  subject: string | null | undefined,
  concept: string | null | undefined,
  knowledgeLevel: number
): string {
  const lines = [
    `Subject: ${subject || pedagogy.subject}`,
    concept ? `Focus concept: ${concept}` : '',
    `Estimated mastery on focus: ${(knowledgeLevel * 100).toFixed(0)}%`,
    pedagogy.localContext ? `Context: ${pedagogy.localContext}` : '',
    pedagogy.examTips ? `Exam posture: ${pedagogy.examTips}` : '',
    pedagogy.commonMisconceptions?.length
      ? `Watch for misconceptions: ${pedagogy.commonMisconceptions.slice(0, 4).join('; ')}`
      : '',
    pedagogy.analogyDomains?.length
      ? `Good analogy domains: ${pedagogy.analogyDomains.slice(0, 5).join(', ')}`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * No hardcoded subject packs. Ensures the generic template is available in
 * system_config for operators to clone when creating new subject pedagogies.
 */
export async function seedDefaultPedagogies(): Promise<void> {
  await db
    .query(
      `INSERT INTO system_config (key, content) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      ['pedagogy_general', JSON.stringify(GENERIC_PEDAGOGY)]
    )
    .catch(err => logger.debug({ err }, '[Pedagogy] seed generic failed'));
}

/**
 * Dynamically upsert pedagogy for a discovered subject (e.g. from sleep mode
 * or admin tooling). Callers supply content — never a fixed subject list.
 */
export async function upsertSubjectPedagogy(
  subject: string,
  pedagogy: Partial<SubjectPedagogy>
): Promise<void> {
  const slug = slugSubject(subject);
  if (!slug) return;
  const payload: SubjectPedagogy = {
    ...GENERIC_PEDAGOGY,
    ...pedagogy,
    subject,
  };
  await db.query(
    `INSERT INTO system_config (key, content) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content`,
    [`pedagogy_${slug}`, JSON.stringify(payload)]
  );
}
