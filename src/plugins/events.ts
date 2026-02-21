import { createLogger } from "../logger";
import type { PluginEvent, PluginEventHandler } from "../types";

const log = createLogger("plugins:events");

export interface PluginEventBus {
  emit(event: PluginEvent, data: unknown): Promise<void>;
  on(event: PluginEvent, pluginName: string, handler: PluginEventHandler): void;
  off(event: PluginEvent, pluginName: string, handler: PluginEventHandler): void;
  removeAll(pluginName: string): void;
}

export class InMemoryPluginEventBus implements PluginEventBus {
  private readonly handlers = new Map<PluginEvent, Map<string, Set<PluginEventHandler>>>();

  async emit(event: PluginEvent, data: unknown): Promise<void> {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      return;
    }

    const work: Promise<void>[] = [];

    for (const pluginHandlers of eventHandlers.values()) {
      for (const handler of pluginHandlers.values()) {
        work.push(this.runHandler(handler, data));
      }
    }

    await Promise.all(work);
  }

  on(event: PluginEvent, pluginName: string, handler: PluginEventHandler): void {
    const eventHandlers = this.ensureEventHandlers(event);
    const pluginHandlers = eventHandlers.get(pluginName) ?? new Set<PluginEventHandler>();
    pluginHandlers.add(handler);
    eventHandlers.set(pluginName, pluginHandlers);
  }

  off(event: PluginEvent, pluginName: string, handler: PluginEventHandler): void {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      return;
    }

    const pluginHandlers = eventHandlers.get(pluginName);
    if (!pluginHandlers) {
      return;
    }

    pluginHandlers.delete(handler);

    if (pluginHandlers.size === 0) {
      eventHandlers.delete(pluginName);
    }

    if (eventHandlers.size === 0) {
      this.handlers.delete(event);
    }
  }

  removeAll(pluginName: string): void {
    for (const [event, eventHandlers] of this.handlers.entries()) {
      eventHandlers.delete(pluginName);

      if (eventHandlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  private ensureEventHandlers(event: PluginEvent): Map<string, Set<PluginEventHandler>> {
    const existing = this.handlers.get(event);
    if (existing) {
      return existing;
    }

    const created = new Map<string, Set<PluginEventHandler>>();
    this.handlers.set(event, created);
    return created;
  }

  private async runHandler(handler: PluginEventHandler, data: unknown): Promise<void> {
    try {
      await handler(data);
    } catch (e) {
      // Expected: handler errors must not stop event delivery to other plugins
      log.debug("plugin event handler error", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
