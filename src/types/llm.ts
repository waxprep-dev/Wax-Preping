export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelConfig {
  provider: "groq" | "openrouter" | "openai" | "anthropic";
  model: string;
  maxTokens: number;
  temperature: number;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
}

// The structured shape we always ask the LLM to return.
// Using zod for runtime validation.
export interface StructuredTutorResponse {
  responseText: string;
  emotionalTone: "warm" | "encouraging" | "neutral" | "concerned" | "playful";
  confidence: number;
  detectedStudentState: {
    topic: string | null;
    misconception: string | null;
    understanding: number;
    emotionalState: string;
  };
  memoryUpdates?: {
    block: "humanProfile" | "learningStyle" | "progress" | "shameMap" | "curiosityMap" | "procedural";
    operation: "append" | "replace" | "delete";
    content: string;
  }[];
  suggestedNextAction: string;
  usedTool: boolean;
  toolName?: string;
}