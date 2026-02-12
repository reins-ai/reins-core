import { ToolError } from "../errors";
import type { Tool, ToolDefinition } from "../types";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const toolName = tool.definition.name;

    if (this.tools.has(toolName)) {
      throw new ToolError(`Tool already registered: ${toolName}`);
    }

    this.tools.set(toolName, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getOrThrow(name: string): Tool {
    const tool = this.get(name);

    if (!tool) {
      throw new ToolError(`Tool not found: ${name}`);
    }

    return tool;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.definition);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  clear(): void {
    this.tools.clear();
  }
}
