/**
 * Notification agent: writes and sends proactive WhatsApp messages.
 *
 * v2 changes:
 * - Persona prompt is DB-evolvable.
 * - Student context now includes extracted facts (name, goals) and facts from
 *   the student model, so messages can be genuinely personal.
 * - All queueing uses dedupe keys — the v1 "same message every 5 minutes"
 *   spam bug cannot recur.
 */
import { callBrain } from './llama_server';
import { getPrompt } from '../config/prompts';
import { db } from '../db/client';
import { sendTextMessage } from '../whatsapp/sender';
import { logger } from '../middleware/logger';

async function getStudentContext(studentId: string): Promise<string> {
  const profile = await db.query(
    `SELECT memory_blocks, study_streak, last_study_date, exam_targets, concept_progress, error_diary FROM student_profiles WHERE student_id = $1`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  if (profile.rows.length === 0) return 'New student — no history.';

  const row = profile.rows[0];
  const memBlocks = row.memory_blocks || {};
  const cp = (row.concept_progress || {}) as Record<string, { masteryLevel: number }>;
  const concepts = Object.entries(cp);
  concepts.sort((a, b) => b[1].masteryLevel - a[1].masteryLevel);

  const facts = await db.query(
    `SELECT fact_key, fact_value FROM student_facts WHERE student_id = $1 ORDER BY confidence DESC LIMIT 8`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  const recentTurns = await db.query(
    `SELECT student_message, topic FROM conversation_turns WHERE student_id = $1 ORDER BY timestamp DESC LIMIT 3`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  return `Facts: ${facts.rows.map((f: Record<string, unknown>) => `${f.fact_key}=${f.fact_value}`).join('; ') || 'none known'}
Profile: ${((memBlocks.humanProfile as string) || 'unknown').slice(0, 150)}
Streak: ${row.study_streak} days | Last studied: ${row.last_study_date || 'never'}
Exams: ${JSON.stringify(row.exam_targets || []).slice(0, 150)}
Strongest: ${concepts.slice(0, 2).map(([k]) => k).join(', ') || 'none'}
Weakest: ${concepts.filter(([, v]) => v.masteryLevel < 0.4).slice(0, 2).map(([k]) => k).join(', ') || 'none'}
Recent topics: ${recentTurns.rows.map((t: Record<string, unknown>) => t.topic || 'general').join(', ')}`;
}

export async function generatePersonalizedNotification(
  studentId: string,
  type: string,
  contextSummary: string
): Promise<string | null> {
  const studentContext = await getStudentContext(studentId);

  const typeGuides: Record<string, string> = {
    exam_today: 'Exam is TODAY. Be calm and specific. Reference what they are strong in. No new advice.',
    exam_tomorrow: 'Exam is TOMORROW. Offer one last review of their weakest area. Remind them about sleep and food.',
    re_engagement: '3+ days inactive. Reach out warmly. Reference their last topic. No guilt, no pressure.',
    spaced_review: 'Concept due for review. Make it sound curious and light, not a task. Ask them ONE quick question on the concept.',
    streak_milestone: 'Study streak milestone. Celebrate with specific reference to what they achieved.',
    frustration_recovery: 'Student was frustrated last session. Check in gently. Acknowledge the difficulty without dwelling on it.',
    frustration_prevention: 'World model predicts frustration. Send warmth and an easy win before their next session.',
    shame_recovery: 'Student showed shame last session. Just be warm and inviting. Do NOT reference the struggle directly.',
    breakthrough_celebration: 'Student just mastered something they struggled with. Celebrate specifically and genuinely.',
    general: contextSummary,
  };

  try {
    const persona = await getPrompt('notification_persona.v1');
    const prompt = `${persona}

STUDENT CONTEXT:
${studentContext}

MESSAGE TYPE: ${type}
WHAT THIS SHOULD DO: ${typeGuides[type] || contextSummary}

Write the WhatsApp message now. Only the message text.`;

    const message = await callBrain(prompt, 0.7, 250);
    if (!message || message.length < 10) return null;
    return message.trim();
  } catch (err) {
    logger.debug({ err }, '[NotificationAgent] Generation failed');
    return null;
  }
}

export async function processPendingNotifications(): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) return;

  const result = await db.query(
    `SELECT id, student_id, type, content FROM notification_queue
     WHERE sent = FALSE AND scheduled_at <= NOW()
     ORDER BY priority DESC, scheduled_at ASC LIMIT 20`
  ).catch(() => ({ rows: [] }));

  for (const row of result.rows) {
    try {
      let message = row.content as string;

      // If content reads like a task description rather than a message, generate the actual message
      if (message.length > 60 && !message.includes('?') && /student|send|celebrate|remind/i.test(message)) {
        const generated = await generatePersonalizedNotification(row.student_id, row.type, message);
        if (generated) message = generated;
      }

      await sendTextMessage(phoneNumberId, row.student_id, message);
      await db.query(`UPDATE notification_queue SET sent = TRUE, sent_at = NOW() WHERE id = $1`, [row.id]);
      logger.info(`[NotificationAgent] Sent ${row.type} to ${row.student_id}`);
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      logger.warn({ err }, '[NotificationAgent] Send failed');
    }
  }
}
