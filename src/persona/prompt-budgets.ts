export interface SectionBudget {
  maxChars: number;
  reservedMinimumChars?: number;
}

export interface PromptBudgetConfig {
  PERSONALITY: SectionBudget;
  BOUNDARIES: SectionBudget;
  USER: SectionBudget;
  KNOWLEDGE: SectionBudget;
  TOOLS: SectionBudget;
  ROUTINES: SectionBudget;
  GOALS: SectionBudget;
  HEARTBEAT: SectionBudget;
  MEMORY: SectionBudget;
}

export const DEFAULT_SECTION_BUDGETS: PromptBudgetConfig = {
  PERSONALITY: {
    maxChars: 3000,
    reservedMinimumChars: 500,
  },
  BOUNDARIES: {
    maxChars: 2000,
    reservedMinimumChars: 300,
  },
  USER: {
    maxChars: 2000,
    reservedMinimumChars: 200,
  },
  KNOWLEDGE: {
    maxChars: 500,
  },
  TOOLS: {
    maxChars: 1000,
  },
  ROUTINES: {
    maxChars: 1000,
  },
  GOALS: {
    maxChars: 1000,
  },
  HEARTBEAT: {
    maxChars: 1000,
  },
  MEMORY: {
    maxChars: 2000,
  },
};
