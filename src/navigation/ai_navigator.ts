/**
 * AI-Driven Navigation — replaces hardcoded curriculum graphs.
 *
 * The tutor model decides what to teach based on:
 * 1. Student profile (attributes, goals, gaps)
 * 2. Syllabus reference (queried on-demand)
 * 3. Real-time BKT mastery state
 * 4. Motivational state (engagement, frustration)
 *
 * No prerequisite chains. No sequence numbers. The AI navigates freely.
 */
import { searchSyllabus, getChunksByTopic } from '../syllabus/store';
import { getActiveAttributes, getPromptGradeAttributes } from '../student_profile/attribute_pipeline';
import { getArchetypePromptModifier } from '../student_profile/archetypes';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { routeAndCall } from '../llm/router';

export interface NavigationContext {
  studentId: string;
  currentTopic: string | null;
  currentSubject: string | null;
  studentMessage: string;
  perceptionIntent: string;
  bktMastery: Record<string, number>;
  recentErrors: string[];
  emotionalState: {
    frustration: number;
    curiosity: number;
    selfEfficacy: number;
  };
}

export interface NavigationDecision {
  nextTopic: string | null;
  nextSubject: string | null;
  reasoning: string;
  suggestedStrategy: string;
  suggestedTools: string[];
  syllabusContext: string;
}

/**
 * Decide what to teach next. This is called by the deliberation layer.
 */
export async function decideNextTopic(ctx: NavigationContext): Promise<NavigationDecision> {
  const start = Date.now();

  // Gather all context
  const [attributes, archetypeModifier, syllabusResults] = await Promise.all([
    getPromptGradeAttributes(ctx.studentId),
    getArchetypePromptModifier(ctx.studentId),
    ctx.currentSubject
      ? searchSyllabus({ query: ctx.studentMessage, subject: ctx.currentSubject, limit: 3 })
      : Promise.resolve([]),
  ]);

  // Build the navigation prompt
  const bktContext = Object.entries(ctx.bktMastery)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 8)
    .map(([topic, prob]) => `${topic}: ${(prob * 100).toFixed(0)}%`)
    .join(', ');

  const prompt = [
    `You are an expert WAEC/JAMB tutor deciding what to teach next.`,
    ``,
    `STUDENT PROFILE:`,
    `- Archetype modifier: ${archetypeModifier || 'Unknown'}`,
    `- Active attributes: ${JSON.stringify(attributes).slice(0, 500)}`,
    `- BKT mastery (weakest first): ${bktContext || 'No mastery data yet'}`,
    `- Recent errors: ${ctx.recentErrors.slice(0, 5).join('; ') || 'None recorded'}`,
    `- Emotional state: frustration=${ctx.emotionalState.frustration.toFixed(2)}, curiosity=${ctx.emotionalState.curiosity.toFixed(2)}, self-efficacy=${ctx.emotionalState.selfEfficacy.toFixed(2)}`,
    ``,
    `CURRENT STATE:`,
    `- Subject: ${ctx.currentSubject || 'Unknown'}`,
    `- Topic: ${ctx.currentTopic || 'None'}`,
    `- Student just said: "${ctx.studentMessage.slice(0, 300)}"`,
    `- Perceived intent: ${ctx.perceptionIntent}`,
    ``,
    `AVAILABLE SYLLABUS CONTENT:`,
    syllabusResults.length > 0
      ? syllabusResults.map(s => `- ${s.topic} / ${s.subTopic}: ${s.objectives.join('; ')}`).join('\n')
      : 'No syllabus results. The student may be off-topic or the subject is not yet loaded.',
    ``,
    `NAVIGATION RULES:`,
    `- You may jump to ANY topic the student shows readiness for.`,
    `- You may return to a foundational topic if BKT shows a gap.`,
    `- You may skip topics entirely if they are irrelevant to the student goals.`,
    `- You must query the syllabus before claiming a topic exists.`,
    `- Consider the student's emotional state: if frustrated, simplify or change topic.`,
    `- If the student is in flow (high curiosity, high self-efficacy), advance to the next challenge.`,
    ``,
    `Respond with JSON only:`,
    `{"nextTopic": "topic_name_or_null", "nextSubject": "subject_or_null", "reasoning": "why you chose this", "suggestedStrategy": "strategy_name", "suggestedTools": ["tool1", "tool2"]}`,
  ].join('\n');

  try {
    const response = await routeAndCall([
      { role: 'system', content: 'You are a navigation engine for an AI tutor. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ], {
      tier: 'smart',
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.3,
      studentId: ctx.studentId,
      purpose: 'navigation',
    });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());

    const decision: NavigationDecision = {
      nextTopic: parsed.nextTopic || null,
      nextSubject: parsed.nextSubject || ctx.currentSubject,
      reasoning: parsed.reasoning || 'No reasoning provided',
      suggestedStrategy: parsed.suggestedStrategy || 'direct_explanation',
      suggestedTools: Array.isArray(parsed.suggestedTools) ? parsed.suggestedTools : [],
      syllabusContext: syllabusResults.length > 0
        ? syllabusResults.map(s => `${s.topic}: ${s.contentText.slice(0, 200)}`).join('\n')
        : '',
    };

    // Log the decision
    await db.query(
      `INSERT INTO tutor_decision_logs (
        student_id, decision_type, reasoning, context_snapshot,
        selected_topic, selected_strategy, tools_considered
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ctx.studentId,
        'topic_navigation',
        decision.reasoning,
        JSON.stringify({
          currentTopic: ctx.currentTopic,
          currentSubject: ctx.currentSubject,
          bktMastery: ctx.bktMastery,
          emotionalState: ctx.emotionalState,
        }),
        decision.nextTopic,
        decision.suggestedStrategy,
        decision.suggestedTools,
      ]
    );

    logger.info(
      `[Navigator] ${ctx.studentId}: ${ctx.currentTopic || 'none'} → ${decision.nextTopic || 'none'} | ${decision.reasoning}`
    );

    return decision;
  } catch (err) {
    logger.warn({ err }, '[Navigator] Decision failed, using fallback');

    // Fallback: if current topic exists, stay there. Otherwise, pick from syllabus.
    const fallbackTopic = ctx.currentTopic || (syllabusResults[0]?.topic || null);

    return {
      nextTopic: fallbackTopic,
      nextSubject: ctx.currentSubject,
      reasoning: 'Navigation decision failed — using safe fallback',
      suggestedStrategy: 'direct_explanation',
      suggestedTools: ['syllabus_query'],
      syllabusContext: '',
    };
  }
}

/**
 * Get recent errors for a student (last 3 turns with misconceptions).
 */
export async function getRecentErrors(studentId: string, limit = 3): Promise<string[]> {
  const result = await db.query(
    `SELECT ai_analysis->>'misconceptionDescription' as error
     FROM conversation_turns
     WHERE student_id = $1 
       AND ai_analysis->>'misconceptionDescription' IS NOT NULL
     ORDER BY timestamp DESC
     LIMIT $2`,
    [studentId, limit]
  );

  return result.rows
    .map((r: Record<string, unknown>) => r.error as string)
    .filter(Boolean);
}