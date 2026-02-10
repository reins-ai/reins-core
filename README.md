# Reins

Open personal assistant platform for terminal, desktop, and mobile.

## Architecture Overview

Reins is split into seven repositories so each platform and service can evolve independently while sharing a single TypeScript core.

| Repository | Package | Responsibility |
|------------|---------|----------------|
| [reins-core](https://github.com/hffmnnj/reins-core) | `@reins/core` | Shared conversation harness, provider abstractions, memory, and plugin APIs |
| [reins-tui](https://github.com/hffmnnj/reins-tui) | `@reins/tui` | Terminal interface powered by OpenTUI and Bun |
| [reins-desktop](https://github.com/hffmnnj/reins-desktop) | `@reins/desktop` | Desktop client powered by Tauri v2 |
| [reins-mobile](https://github.com/hffmnnj/reins-mobile) | `@reins/mobile` | React Native client for iOS and Android |
| [reins-gateway](https://github.com/hffmnnj/reins-gateway) | `@reins/gateway` | Model gateway, API key abstraction, metering, and billing |
| [reins-backend](https://github.com/hffmnnj/reins-backend) | `@reins/backend` | Convex backend services and app data APIs |
| [reins-sdk](https://github.com/hffmnnj/reins-sdk) | `@reins/sdk` | Third-party plugin SDK |

## Stack Summary

- Runtime: Bun
- Language: TypeScript (strict mode)
- Backend: Convex
- Authentication: Clerk (Organizations)
- TUI: OpenTUI
- Desktop: Tauri v2
- Mobile: React Native
- Design system: shared tokens + headless UI logic

## Quick Start

1. Clone all repositories into the same parent directory.
2. In `reins-core`, install dependencies and run checks:

```bash
bun install
bun run typecheck
bun test
```

3. Link `@reins/core` locally:

```bash
bun link
```

4. In any downstream repo (for example `reins-tui`), link the local core package and run typecheck:

```bash
bun link @reins/core
bun run typecheck
```

## Repository Links

- https://github.com/hffmnnj/reins-core
- https://github.com/hffmnnj/reins-tui
- https://github.com/hffmnnj/reins-desktop
- https://github.com/hffmnnj/reins-mobile
- https://github.com/hffmnnj/reins-gateway
- https://github.com/hffmnnj/reins-backend
- https://github.com/hffmnnj/reins-sdk
