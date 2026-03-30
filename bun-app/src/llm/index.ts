/**
 * Isolated module: interpretation and task-classification LLM providers.
 * Configure via env / config.json; see `resolve.ts`.
 */
export {
  getInterpretationProvider,
  getInterpretationLlmResolved,
  type InterpretationProvider,
  type InterpretationLlmResolved,
  resolveInterpretationApiKey,
  resolveInterpretationBaseUrl,
  resolveApiKeyForProvider,
  resolveAnthropicApiKey,
  resolveGeminiApiKey,
  getInterpretationModel,
  // Task classifier
  getClassificationLlmResolved,
  getClassificationProvider,
  resolveApiKeyForClassifier,
  type ClassificationLlmResolved,
} from "./resolve";
export {
  getInterpretationClient,
  invalidateInterpretationClient,
  interpretationChatCompletionsUrl,
} from "./client";
export { completeInterpretation, completeClassification } from "./complete";
