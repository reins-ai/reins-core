import type { ModelCapability } from "../types";

export interface ToolPermissionSet {
  mode: "allowlist" | "blocklist" | "all";
  tools?: string[];
}

export interface ModelPreference {
  preferred?: string[];
  required?: ModelCapability[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolPermissions: ToolPermissionSet;
  modelPreferences?: ModelPreference;
  temperature?: number;
  metadata?: Record<string, unknown>;
}
