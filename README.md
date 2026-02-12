# @reins/core

Shared TypeScript core for the Reins platform.

`@reins/core` contains the reusable assistant runtime used by TUI, Desktop, Mobile, and supporting services.

## What This Repo Provides

- Conversation management and persistence abstractions
- Provider interfaces and routing primitives
- Streaming event model
- Tool registry/executor and built-in tools
- Plugin lifecycle, permissions, installer, and sandbox runtime
- Voice, persona, context-window, and memory modules

## Architecture Overview

```text
src/
  conversation/  -> Conversation manager + stores
  providers/     -> Provider registry/router + provider families
  tools/         -> Tool contracts + executor + built-in tools
  plugins/       -> Manifest/lifecycle/permissions/sandbox/loader
  streaming/     -> Stream response primitives
  memory/        -> Memory store contracts + implementations
  persona/       -> Persona and prompt assembly
  context/       -> Context-window management
  types/         -> Shared platform contracts
tests/
  unit + integration + cross-platform + e2e + security suites
```

## Setup

```bash
bun install
```

## Scripts

- `bun run typecheck` - TypeScript checks
- `bun test` - Full test suite
- `bun run build` - TypeScript build output

## Development Workflow

Local linking for downstream repos:

```bash
# in this repo
bun link

# in downstream repo
bun link @reins/core
```

## Test Commands

- Full suite: `bun test`
- Typecheck: `bun run typecheck`

## Related Docs

- Root docs: `../README.md`
- Core API: `../docs/api/core.md`
- Plugin guide: `../docs/plugin-guide.md`
