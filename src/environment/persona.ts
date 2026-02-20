import yaml from "js-yaml";

import { ok, type Result } from "../result";
import type { EnvironmentError } from "./errors";

interface PersonaObject {
  name?: unknown;
  backstory?: unknown;
  avatar?: unknown;
  language?: unknown;
}

export interface Persona {
  name: string;
  backstory?: string;
  avatar?: string;
  language?: string;
}

export const DEFAULT_PERSONA: Persona = {
  name: "Reins",
  avatar: "🤖",
  language: "en",
};

export function parsePersonaYaml(content: string): Result<Persona, EnvironmentError> {
  const fallback = { ...DEFAULT_PERSONA };

  if (!content.trim()) {
    return ok(fallback);
  }

  try {
    const parsed = yaml.load(content);
    if (!isObject(parsed)) {
      return ok(fallback);
    }

    const candidate = parsed as PersonaObject;
    const name = readNonEmptyString(candidate.name) ?? DEFAULT_PERSONA.name;
    const backstory = readNonEmptyString(candidate.backstory);
    const language = readNonEmptyString(candidate.language) ?? DEFAULT_PERSONA.language;

    const persona: Persona = {
      name,
      language,
    };

    if (typeof candidate.avatar === "undefined") {
      persona.avatar = DEFAULT_PERSONA.avatar;
    } else {
      const avatar = readNonEmptyString(candidate.avatar);
      if (avatar) {
        persona.avatar = avatar;
      }
    }

    if (backstory) {
      persona.backstory = backstory;
    }

    return ok(persona);
  } catch {
    return ok(fallback);
  }
}

export function generateDefaultPersonaYaml(): string {
  return "name: Reins\navatar: 🤖\nlanguage: en\n";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
