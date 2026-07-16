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
  chainLog?: Record<string, unknown>[];
  reflectionScore?: number;
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

export type AnyEvent =
  | TutorResponseGenerated
  | EmotionalAlert
  | MasteryDetected
  | PromptEvolved
  | DefenseTriggered
  | ReflectionStored;
