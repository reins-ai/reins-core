<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7+-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Bun-1.0+-f97316?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/Tests-401_passing-22c55e?style=for-the-badge" alt="Tests" />
  <img src="https://img.shields.io/badge/License-MIT-a855f7?style=for-the-badge" alt="MIT License" />
</p>

# @reins/core

The shared runtime that powers [Reins](https://reinsbot.com) across every platform. Pure TypeScript, zero platform dependencies, exhaustively tested.

Every Reins client — terminal, desktop, mobile — depends on this library for conversations, model routing, tool execution, plugin sandboxing, memory, streaming, and more. It's the brain of the operation.

## Quick Start

```bash
bun install
bun test          # 401 tests
bun run typecheck # strict mode, no escape hatches
```

### Linking for Development

Every other Reins repo consumes `@reins/core` as a local file dependency. During development, link it so changes propagate immediately:

```bash
# in this repo
bun link

# in any consumer (reins-tui, reins-gateway, reins-backend, etc.)
bun link @reins/core
```

---

## What's Inside

### Conversation Engine

Full lifecycle management for multi-turn conversations. Create, fork, search, compact, and persist conversations through a pluggable `ConversationStore` interface. Includes context-window management with automatic compaction when token limits approach, transcript storage for long-term history, and session tracking across devices.

```typescript
import { ConversationManager } from "@reins/core/conversation";

const manager = new ConversationManager({ store, sessionRepo });
const conversation = await manager.create({
  title: "Morning checkin",
  model: "claude-sonnet-4-20250514",
  provider: "anthropic",
});
```

### Provider System

A three-tier provider architecture that covers every way a user might connect to an LLM:

| Family | What it does | Providers |
|--------|-------------|-----------|
| **BYOK** | User supplies their own API key. Encrypted at rest, validated on add. | Anthropic, OpenAI, Google |
| **OAuth** | Browser-based auth flow, token refresh, keepalive. | Anthropic, OpenAI, Google, Kimi, GLM, Minimax |
| **Local** | Connects to models running on the user's machine. | Ollama, vLLM |

All providers implement the same `Provider` interface — `chat()`, `stream()`, `listModels()`, `validateConnection()` — so the rest of the system doesn't care where a model lives.

The `ProviderRegistry` stores providers by ID, and the `ModelRouter` routes requests to the right provider + model based on capability requirements.

### Streaming

SSE-based streaming with typed events. The `StreamTransformer` parses raw server-sent events into a clean event stream:

```typescript
type StreamEvent =
  | { type: "token"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_end"; id: string; result: string }
  | { type: "error"; error: Error }
  | { type: "done"; usage?: TokenUsage };
```

### Built-in Tools

Conversation-driven tools that let the assistant interact with the user's data:

- **Calendar** — create, view, update, and delete events with recurrence support
- **Reminders** — manage reminders with priority, snooze, and recurring schedules
- **Notes** — full CRUD with tags, folders, linking, and search
- **Voice** — enable/disable voice I/O, set language and input mode
- **Web Search** — search the web from conversation context
- **Documents** — parse and extract content from PDFs, DOCX, XLSX, and more
- **Memory** — save, recall, and search long-term memory from conversation
- **Schedule** — view and manage scheduled tasks and cron jobs
- **Delegation** — delegate sub-tasks to specialized tool chains

The `ToolRegistry` discovers tools, and the `ToolExecutor` runs them with proper context injection, abort signal support, and error handling.

### Plugin System

Full plugin lifecycle with security sandboxing:

- **Manifest** — declarative plugin metadata (name, version, permissions, tools)
- **Permissions** — granular capability grants (data access, network, tools)
- **Sandbox** — plugins run in isolated `worker_threads` with enforced boundaries
- **Loader** — load plugins from local paths or npm packages
- **Lifecycle** — activate, deactivate, health checks, state management
- **Audit** — track plugin actions and permission usage
- **Marketplace** — browse and install plugins from ClawHub and other sources

### Memory

Persistent memory with capture, consolidation, search, and retrieval:

- Automatic memory capture from conversations
- Embedding-based semantic search (RAG pipeline)
- Proactive memory surfacing during conversations
- Consolidation to merge and deduplicate stored memories
- Pluggable storage backends (local file, SQLite)

### Channels

Connect Reins to external messaging platforms:

- **Discord** and **Telegram** adapters
- Conversation bridging — external messages flow into the same conversation engine
- Per-channel auth with allow-list access control
- Voice message transcription support

### Browser Automation

Chrome DevTools Protocol (CDP) integration for web interaction:

- Chrome process discovery and management
- Page snapshots and element targeting
- Stealth mode for automation-resistant sites
- Watcher system for monitoring page changes on a schedule

### Additional Modules

| Module | Purpose |
|--------|---------|
| `persona/` | System prompt assembly, persona registry, environment context injection |
| `onboarding/` | First-run detection, setup wizard steps, personality presets |
| `skills/` | Skill scanner, registry, matcher, and runtime — loadable instruction sets |
| `agents/` | Agent identity, workspace management, migration tooling |
| `cron/` | Job scheduler, rate limiter, executor with retry policies |
| `daemon/` | Background daemon runtime, service installer, WebSocket stream registry |
| `sync/` | Account sync, conflict resolution policies, change triggers |
| `security/` | Keychain provider, machine auth tokens, security error hierarchy |
| `config/` | User config, environment detection, data root resolution |
| `tokens/` | Design tokens — colors, spacing, typography for consistent UI |
| `conversion/` | Import/migration from other assistant platforms |
| `marketplace/` | Plugin registry with ClawHub source and install pipeline |
| `harness/` | Test harness utilities for integration testing |

---

## Architecture

```
src/
├── conversation/     Conversation manager, stores, compaction, sessions
├── providers/
│   ├── byok/         Bring-your-own-key providers (Anthropic, OpenAI, Google)
│   ├── oauth/        OAuth providers with token management
│   ├── local/        Ollama + vLLM adapters
│   ├── registry.ts   Provider registration and lookup
│   └── router.ts     Capability-based model routing
├── streaming/        SSE stream transformer and response types
├── tools/            Tool registry, executor, and 10+ built-in tools
├── plugins/          Plugin manifest, lifecycle, permissions, sandbox
├── memory/           Capture, consolidation, RAG search, storage
├── channels/         Discord + Telegram adapters, conversation bridging
├── browser/          CDP client, Chrome finder, page snapshots
├── persona/          System prompt builder, persona registry
├── skills/           Skill scanner, matcher, runner
├── daemon/           Background daemon, WebSocket streams, service installer
├── cron/             Job scheduler, rate limiter, executor
├── onboarding/       First-run flow, personality presets
├── agents/           Agent identity and workspace management
├── security/         Keychain, machine auth, security errors
├── sync/             Account sync and conflict resolution
├── tokens/           Design tokens (colors, spacing, typography)
├── cli/              CLI entry point and setup wizard
├── types/            Shared type definitions
└── index.ts          Barrel exports
```

## Error Handling

The codebase uses a dual approach:

**Custom error classes** for synchronous and invariant failures:

```typescript
throw new ProviderError("Provider is required to add BYOK key");
throw new ConversationError("Conversation not found");
```

Error hierarchy: `ReinsError` → `ProviderError`, `AuthError`, `ToolError`, `PluginError`, `ConversationError`

**Result type** for operations where failure is expected:

```typescript
import { ok, err, type Result } from "@reins/core/result";

function validateKey(key: string): Result<KeyInfo> {
  if (!key.startsWith("sk-")) return err(new ReinsError("Invalid key format", "INVALID_KEY"));
  return ok({ key, provider: "openai" });
}
```

## Exports

The package exposes granular entry points so consumers can import only what they need:

```typescript
import { ConversationManager } from "@reins/core/conversation";
import { ProviderRegistry } from "@reins/core/providers";
import { ToolExecutor } from "@reins/core/tools";
import { StreamTransformer } from "@reins/core/streaming";
import { colors, spacing } from "@reins/core/tokens";
```

Full list: `@reins/core`, `@reins/core/config`, `@reins/core/conversation`, `@reins/core/context`, `@reins/core/errors`, `@reins/core/memory`, `@reins/core/persona`, `@reins/core/plugins`, `@reins/core/providers`, `@reins/core/result`, `@reins/core/streaming`, `@reins/core/tokens`, `@reins/core/tools`, `@reins/core/types`, `@reins/core/utils`, `@reins/core/voice`, `@reins/core/onboarding`, `@reins/core/skills`

## Scripts

| Command | Description |
|---------|-------------|
| `bun test` | Run the full 401-test suite |
| `bun run typecheck` | TypeScript strict mode check |
| `bun run build` | Compile TypeScript |

## Links

- [Reins website](https://reinsbot.com)
- [GitHub organization](https://github.com/reins-ai)
- [Core API docs](../docs/api/core.md)
- [Plugin development guide](../docs/plugin-guide.md)

## License

[MIT](./LICENSE)
