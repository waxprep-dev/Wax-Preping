/**
 * Working memory: the current session's mental scratchpad.
 *
 * v1 derived EVERYTHING from regexes over the last 12 turns on every message
 * (detecting "did the tutor use an analogy" by matching /like|imagine/ in
 * tutor text — fragile and often wrong). v2 merges two sources:
 *   1. the persisted SessionState row (ground truth written by the pipeline:
 *      current concept, hint level, approaches tried, struggle count)
 *   2. salience-ranked recent turns (for conversational texture)
 */
import type { ConversationTurn, SessionState, WorkingMemorySnapshot, SalientTurn } from '../types/student';

function salienceScore(turn: ConversationTurn): number {
  let score = 0;
  const combined = `${turn.studentMessage} ${turn.tutorResponse}`.toLowerCase();

  if (/don't get|confused|stuck|don't understand|not following/.test(combined)) score += 3;
  if (/oh i see|got it|makes sense|clicked|oh so that's/.test(combined)) score += 3;
  if (turn.masteryEvidenced) score += 3;
  if (turn.studentMessage.includes('?') && turn.studentMessage.length > 25) score += 1;

  const ageMs = Date.now() - new Date(turn.timestamp).getTime();
  score += Math.max(0, 2 - ageMs / (5 * 60 * 1000));

  return score;
}

export function buildWorkingMemory(history: ConversationTurn[], state: SessionState): WorkingMemorySnapshot {
  if (history.length === 0) {
    return {
      currentTopic: state.currentConcept,
      currentSubject: state.currentSubject,
      lastMisconception: null,
      lastAnalogyUsed: null,
      studentConfidence: 0.5,
      turnsInCurrentTopic: 0,
      salienceRankedTurns: [],
      backgroundSummary: 'First message of this session.',
      unresolvedQuestion: state.unresolvedQuestion,
      stuckRepetitionCount: state.struggleCount,
      approachesAttempted: [...state.approachesTried],
      conceptsVisitedThisSession: [],
      hintLevelCurrent: state.hintLevel,
      lastScaffoldUsed: null,
      lastPaceUsed: 'normal',
      lastStrategy: state.lastStrategy,
      bloomLevel: state.bloomLevel,
    };
  }

  const scored = history.map(t => ({ turn: t, score: salienceScore(t) }));
  scored.sort((a, b) => b.score - a.score);

  const focus = scored.slice(0, 4);
  const background = scored.slice(4).map(s => s.turn);

  const salienceRankedTurns: SalientTurn[] = focus.flatMap(({ turn, score }) => [
    { role: 'student' as const, content: turn.studentMessage.slice(0, 300), salienceScore: score },
    { role: 'tutor' as const, content: turn.tutorResponse.slice(0, 300), salienceScore: score * 0.8 },
  ]);

  const avgConfidence = history.slice(-3).reduce((s, t) => {
    const se = (t.aiAnalysis?.emotionalReading as { selfEfficacy?: number } | undefined)?.selfEfficacy ?? 0.5;
    return s + se;
  }, 0) / Math.min(3, history.length);

  const lastMsg = history[history.length - 1]?.studentMessage || '';
  const unresolvedQuestion = lastMsg.includes('?') && (history[history.length - 1]?.tutorResponse?.length || 0) < 80
    ? lastMsg
    : state.unresolvedQuestion;

  const bgSummary = background.length === 0
    ? 'Only recent turns available.'
    : background.slice(0, 5).map(t => `S: ${t.studentMessage.slice(0, 60)} | T: ${t.tutorResponse.slice(0, 60)}`).join(' — ');

  return {
    currentTopic: state.currentConcept,
    currentSubject: state.currentSubject,
    lastMisconception: null,
    lastAnalogyUsed: null,
    studentConfidence: avgConfidence,
    turnsInCurrentTopic: history.length,
    salienceRankedTurns,
    backgroundSummary: bgSummary,
    unresolvedQuestion,
    stuckRepetitionCount: state.struggleCount,
    approachesAttempted: [...state.approachesTried],
    conceptsVisitedThisSession: [...new Set(history.filter(t => t.topic).map(t => t.topic!))],
    hintLevelCurrent: state.hintLevel,
    lastScaffoldUsed: state.approachesTried[state.approachesTried.length - 1] || null,
    lastPaceUsed: state.struggleCount >= 3 ? 'slow' : 'normal',
    lastStrategy: state.lastStrategy,
    bloomLevel: state.bloomLevel,
  };
}

export function formatHistoryForOrchestrator(history: ConversationTurn[], limit = 10): string {
  if (history.length === 0) return 'No previous turns in this session.';
  return history.slice(-limit).map(t =>
    `Turn ${t.turnNumber}:\n  Student: "${t.studentMessage.slice(0, 200)}"\n  Tutor: "${t.tutorResponse.slice(0, 200)}"`
  ).join('\n\n');
}
