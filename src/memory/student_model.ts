/**
 * Student-model updater — the component that makes the tutor actually LEARN
 * about the student over time.
 *
 * v1 gap: memory blocks shipped with sensible defaults and, for most
 * students, stayed there forever. humanProfile, learningStyle, curiosityMap,
 * errorPatterns were never updated by anything. The tutor "remembered"
 * almost nothing about who the student is.
 *
 * v2: after every turn (async, off the response path), one deep-tier call
 * extracts durable facts, memory-block edits, concept evidence, analogy usage
 * and error patterns, and applies them. This is the fact-extraction memory
 * pattern from production agent-memory systems, specialized for tutoring.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';
import {
  applyMemoryEdit,
  upsertStudentFacts,
  updateConceptEvidence,
  recordErrorPattern,
  recordAnalogyUse,
} from './semantic';
import type { MemoryBlocks, BloomLevel, StudentProfile } from '../types/student';
import type { PerceptionResult, TeachingPlan } from '../types/teaching';

interface StudentModelUpdate {
  facts?: { key: string; value: string; confidence: number }[];
  memoryUpdates?: { block: keyof MemoryBlocks; operation: 'append' | 'replace' | 'delete'; content: string }[];
  conceptUpdate?: {
    concept: string | null;
    subject: string | null;
    result: 'success' | 'struggle' | 'neutral';
    bloomLevel: BloomLevel;
    misconception: string | null;
  };
  analogyUsed?: { analogy: string | null; domain: string | null; concept: string | null };
  errorPattern?: { concept: string | null; errorType: string | null };
}

export async function updateStudentModel(
  profile: StudentProfile,
  studentMessage: string,
  tutorResponse: string,
  perception: PerceptionResult,
  plan: TeachingPlan
): Promise<void> {
  try {
    const instruction = await getPrompt('student_model.v1');

    const knownFacts = Object.entries(profile.facts)
      .map(([k, f]) => `${k}: ${f.factValue}`)
      .join('; ') || 'none yet';

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          `STUDENT SAID: "${studentMessage.slice(0, 600)}"`,
          `TUTOR REPLIED: "${tutorResponse.slice(0, 600)}"`,
          `Perception: intent=${perception.primaryIntent}, topic=${perception.inferredTopic || 'none'}, subject=${perception.inferredSubject || 'none'}, masterySignal=${perception.masterySignal}, misconception=${perception.misconceptionDescription || 'none'}`,
          `Strategy used: ${plan.strategy}${plan.useAnalogy && plan.analogyDomain ? ` (analogy domain: ${plan.analogyDomain})` : ''}`,
          `Known facts already (do not re-extract): ${knownFacts}`,
          `Current humanProfile: ${profile.memoryBlocks.humanProfile.slice(0, 200)}`,
        ].join('\n'),
      },
    ], { tier: 'deep', jsonMode: true, maxTokens: 600, temperature: 0.2, studentId: profile.studentId, purpose: 'student_model' });

    const update = JSON.parse(response.content.replace(/```json|```/g, '').trim()) as StudentModelUpdate;
    await applyUpdate(profile.studentId, update, perception);
  } catch (err) {
    logger.debug({ err }, '[StudentModel] Update failed — model unchanged this turn');
  }
}

async function applyUpdate(studentId: string, update: StudentModelUpdate, perception: PerceptionResult): Promise<void> {
  if (Array.isArray(update.facts) && update.facts.length > 0) {
    await upsertStudentFacts(studentId, update.facts).catch(() => {});
  }

  if (Array.isArray(update.memoryUpdates)) {
    for (const edit of update.memoryUpdates.slice(0, 4)) {
      if (!edit.block || !edit.content) continue;
      await applyMemoryEdit(studentId, edit.block, edit.operation || 'append', edit.content.slice(0, 400)).catch(() => {});
    }
  }

  const cu = update.conceptUpdate;
  const concept = cu?.concept || perception.inferredTopic;
  if (concept) {
    const result = cu?.result
      || (perception.masterySignal === 'strong' ? 'success' : perception.hasMisconception ? 'struggle' : 'neutral');
    await updateConceptEvidence(
      studentId,
      concept,
      cu?.subject || perception.inferredSubject || 'General',
      result,
      cu?.bloomLevel || 'understand',
      cu?.misconception || perception.misconceptionDescription
    ).catch(() => {});
  }

  if (update.analogyUsed?.analogy && (update.analogyUsed.concept || concept)) {
    const worked = perception.masterySignal === 'strong' ? true : perception.masterySignal === 'none' && perception.hasMisconception ? false : null;
    await recordAnalogyUse(
      studentId,
      update.analogyUsed.concept || concept!,
      update.analogyUsed.analogy.slice(0, 200),
      update.analogyUsed.domain || 'everyday',
      worked
    ).catch(() => {});
  }

  if (update.errorPattern?.concept && update.errorPattern?.errorType) {
    await recordErrorPattern(studentId, update.errorPattern.concept, update.errorPattern.errorType).catch(() => {});
  }
}
