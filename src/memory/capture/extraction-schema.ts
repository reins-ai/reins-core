export const EXTRACTION_CATEGORIES = [
  "decision",
  "fact",
  "preference",
  "action_item",
  "observation",
] as const;

export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];

export interface ExtractedItem {
  category: ExtractionCategory;
  content: string;
  confidence: number;
  tags: string[];
  entities: string[];
  sourceMessageIds: string[];
}

export interface ExtractionResult {
  sessionId: string;
  conversationId: string;
  timestamp: Date;
  items: ExtractedItem[];
  extractionVersion: string;
}

export interface ExtractionConfig {
  confidenceThreshold: number;
  maxItemsPerSession: number;
  enabledCategories: ExtractionCategory[];
}

export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  confidenceThreshold: 0.3,
  maxItemsPerSession: 50,
  enabledCategories: [...EXTRACTION_CATEGORIES],
};
