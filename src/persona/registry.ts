import { DEFAULT_PERSONA } from "./default";
import type { OverlayResolution } from "../environment/types";
import type { Persona } from "./persona";

export class PersonaRegistry {
  private readonly personas = new Map<string, Persona>();
  private defaultPersonaId = DEFAULT_PERSONA.id;

  constructor() {
    this.register(DEFAULT_PERSONA);
  }

  register(persona: Persona): void {
    if (this.personas.has(persona.id)) {
      throw new Error(`Persona already registered: ${persona.id}`);
    }

    this.personas.set(persona.id, persona);
  }

  get(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  getOrThrow(id: string): Persona {
    const persona = this.get(id);

    if (!persona) {
      throw new Error(`Persona not found: ${id}`);
    }

    return persona;
  }

  getDefault(): Persona {
    return this.getOrThrow(this.defaultPersonaId);
  }

  list(): Persona[] {
    return Array.from(this.personas.values());
  }

  remove(id: string): boolean {
    if (id === this.defaultPersonaId) {
      return false;
    }

    return this.personas.delete(id);
  }

  has(id: string): boolean {
    return this.personas.has(id);
  }

  setDefault(id: string): void {
    if (!this.personas.has(id)) {
      throw new Error(`Cannot set default persona. Persona not found: ${id}`);
    }

    this.defaultPersonaId = id;
  }

  resolve(id?: string, environment?: OverlayResolution): Persona {
    const basePersona = id ? this.getOrThrow(id) : this.getDefault();

    if (!environment) {
      return basePersona;
    }

    const personalityDocument = environment.documents.PERSONALITY.document.content.trim();
    if (!personalityDocument) {
      return basePersona;
    }

    return {
      ...basePersona,
      systemPrompt: personalityDocument,
      metadata: {
        ...(basePersona.metadata ?? {}),
        environmentContext: {
          activeEnvironment: environment.activeEnvironment,
          personalitySource: environment.documents.PERSONALITY.sourceEnvironment,
        },
      },
    };
  }
}
