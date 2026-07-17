/**
 * Domain events flowing through the EventBus (Redis Streams with in-memory fallback).
 *
 * v2.0 changes:
 * - Every declared event is now actually published somewhere in the system
 *   (v1 declared EmotionalAlert, PromptEvolved, ReflectionStored and several
 *   EventType members that nothing ever emitted).
 * - Removed the dead ForceVector interface (nothing referenced it).
 */
export type EventType =
  | 'student.message.received'
  | 'tutor.response.generated'
  | 'memory.updated'
  | 'mastery.detected'
  | 'emotional.alert'
  | 'session.started'
  | 'session.ended'
  | 'prompt.evolved'
  | 'defense.triggered'
  | 'reflection.stored'
  | 'spaced.review.due'
  | 'study.streak.updated';

export interface BaseEvent {
  id: string;
  type: EventType;
  studentId: string;
  sessionId: string;
  timestamp: Date;
}

export interface StudentMessageReceived extends BaseEvent {
  type: 'student.message.received';
  modality: string;
  isFirstMessage: boolean;
}

export interface TutorResponseGenerated extends BaseEvent {
  type: 'tutor.response.generated';
  responseText: string;
  modelUsed: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolsUsed: string[];
  defensePassed: boolean;
  defenseIssues: string[];
  strategy?: string;
  reflectionScore?: number;
}

export interface MemoryUpdated extends BaseEvent {
  type: 'memory.updated';
  block: string;
  operation: 'append' | 'replace' | 'delete';
  summary: string;
}

export interface EmotionalAlert extends BaseEvent {
  type: 'emotional.alert';
  emotion: string;
  confidence: number;
  urgency: 'immediate' | 'monitor' | 'low';
  recommendedAction: string;
}

export interface MasteryDetected extends BaseEvent {
  type: 'mastery.detected';
  concept: string;
  evidenceType: string;
  masteryLevel: number;
}

export interface SessionStarted extends BaseEvent {
  type: 'session.started';
  isReturningStudent: boolean;
  daysSinceLastSession: number | null;
}

export interface SessionEnded extends BaseEvent {
  type: 'session.ended';
  turnCount: number;
  conceptsCovered: string[];
}

export interface PromptEvolved extends BaseEvent {
  type: 'prompt.evolved';
  componentId: string;
  oldFitness: number;
  newFitness: number;
}

export interface DefenseTriggered extends BaseEvent {
  type: 'defense.triggered';
  layer: string;
  severity: string;
  issue: string;
  wasFixed: boolean;
}

export interface ReflectionStored extends BaseEvent {
  type: 'reflection.stored';
  critique: string;
  confidenceScore: number;
  improvement: string;
}

export interface SpacedReviewDue extends BaseEvent {
  type: 'spaced.review.due';
  concepts: string[];
}

export interface StudyStreakUpdated extends BaseEvent {
  type: 'study.streak.updated';
  streak: number;
}

export type AnyEvent =
  | StudentMessageReceived
  | TutorResponseGenerated
  | MemoryUpdated
  | EmotionalAlert
  | MasteryDetected
  | SessionStarted
  | SessionEnded
  | PromptEvolved
  | DefenseTriggered
  | ReflectionStored
  | SpacedReviewDue
  | StudyStreakUpdated;
