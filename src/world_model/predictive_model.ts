/**
 * World model: predicts the student's near future (next mistake, forgetting,
 * frustration, exam trajectory). Runs in the background worker every 2h per
 * active student; deliberation reads the latest state as one compact signal.
 * v2: prediction prompt is DB-configurable; frustration-prevention
 * notifications are deduped (no repeat nags).
 */
import { callBrain } from '../brain/llama_server';
import { getPrompt } from '../config/prompts';
import { db } from '../db/client';
import { logger } from '../middleware/logger';

export interface WorldModelPrediction {
  studentId: string;
  predictedNextMistake: string;
  predictedForgetConcepts: string[];
  predictedFrustrationProbability: number;
  predictedFlowProbability: number;
  predictedExamScore: number;
  predictedExamScoreTrend: 'improving' | 'declining' | 'stable';
  modelUpdatedAt: Date;
}

export async function runWorldModel(studentId: string): Promise<WorldModelPrediction | null> {
  try {
    const [profile, recentTurns] = await Promise.all([
      db.query(`SELECT study_streak, total_turns, error_diary, concept_progress, exam_targets FROM student_profiles WHERE student_id = $1`, [studentId]),
      db.query(`SELECT student_message, topic, mastery_evidenced, ai_analysis, timestamp FROM conversation_turns WHERE student_id = $1 ORDER BY timestamp DESC LIMIT 15`, [studentId]),
    ]);

    if (profile.rows.length === 0) return null;

    const row = profile.rows[0];
    const cp = (row.concept_progress || {}) as Record<string, { masteryLevel: number }>;
    const lowMastery = Object.entries(cp).filter(([, v]) => v.masteryLevel < 0.5).map(([k]) => k).slice(0, 5);
    const errorDiary = ((row.error_diary || []) as { concept: string; count: number }[]).map(e => `${e.concept}(${e.count}x)`).join(', ');
    const examTargets = (row.exam_targets || []) as { examDate?: string }[];
    const nextExam = examTargets.find(e => e.examDate && new Date(e.examDate) > new Date());
    const daysToExam = nextExam?.examDate ? Math.ceil((new Date(nextExam.examDate).getTime() - Date.now()) / 86400000) : null;

    const instruction = await getPrompt('world_model.v1');
    const prompt = `${instruction}

Student data:
- Streak: ${row.study_streak} days | Total turns: ${row.total_turns}
- Low-mastery concepts: ${lowMastery.join(', ') || 'none'}
- Recurring errors: ${errorDiary || 'none'}
- Days to next exam: ${daysToExam ?? 'unknown'}
- Recent topics: ${recentTurns.rows.map((t: Record<string, unknown>) => t.topic || 'general').slice(0, 8).join(', ')}
- Recent mastery events: ${recentTurns.rows.filter((t: Record<string, unknown>) => t.mastery_evidenced).length} of last ${recentTurns.rows.length} turns`;

    const response = await callBrain(prompt, 0.3, 500);
    const prediction = JSON.parse(response.replace(/```json|```/g, '').trim()) as Omit<WorldModelPrediction, 'studentId' | 'modelUpdatedAt'>;

    await db.query(
      `INSERT INTO world_model_state (student_id, predicted_next_mistake, predicted_forget_concepts, predicted_frustration_probability, predicted_flow_probability, predicted_exam_score, predicted_exam_score_trend, model_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (student_id) DO UPDATE SET
         predicted_next_mistake=EXCLUDED.predicted_next_mistake,
         predicted_forget_concepts=EXCLUDED.predicted_forget_concepts,
         predicted_frustration_probability=EXCLUDED.predicted_frustration_probability,
         predicted_flow_probability=EXCLUDED.predicted_flow_probability,
         predicted_exam_score=EXCLUDED.predicted_exam_score,
         predicted_exam_score_trend=EXCLUDED.predicted_exam_score_trend,
         model_updated_at=NOW()`,
      [studentId, prediction.predictedNextMistake, prediction.predictedForgetConcepts, prediction.predictedFrustrationProbability, prediction.predictedFlowProbability, prediction.predictedExamScore, prediction.predictedExamScoreTrend]
    );

    if (prediction.predictedFrustrationProbability > 0.7) {
      const dedupeKey = `frustration_prevention:${studentId}:${new Date().toISOString().split('T')[0]}`;
      await db.query(
        `INSERT INTO notification_queue (student_id, type, content, scheduled_at, priority, dedupe_key)
         VALUES ($1,'frustration_prevention',$2,NOW()+INTERVAL '30 minutes',7,$3)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [studentId, 'World model predicts high frustration. Send something warm before their next session.', dedupeKey]
      ).catch(() => {});
    }

    return { ...prediction, studentId, modelUpdatedAt: new Date() };
  } catch (err) {
    logger.debug({ err }, `[WorldModel] Failed for ${studentId}`);
    return null;
  }
}

export async function getWorldModelState(studentId: string): Promise<WorldModelPrediction | null> {
  const result = await db.query(`SELECT * FROM world_model_state WHERE student_id = $1`, [studentId]).catch(() => ({ rows: [] }));
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    studentId: row.student_id,
    predictedNextMistake: row.predicted_next_mistake || '',
    predictedForgetConcepts: row.predicted_forget_concepts || [],
    predictedFrustrationProbability: row.predicted_frustration_probability || 0,
    predictedFlowProbability: row.predicted_flow_probability || 0,
    predictedExamScore: row.predicted_exam_score || 0,
    predictedExamScoreTrend: row.predicted_exam_score_trend || 'stable',
    modelUpdatedAt: new Date(row.model_updated_at),
  };
}
