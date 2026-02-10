# Reins Architecture

## System Overview

```text
                 +-------------------+
                 |    reins-core     |
                 |  @reins/core      |
                 +---------+---------+
                           |
        +------------------+------------------+
        |                  |                  |
 +------+-------+   +------+-------+   +------+-------+
 |  reins-tui   |   | reins-desktop|   | reins-mobile |
 |  @reins/tui  |   | @reins/desktop|  | @reins/mobile|
 +------+-------+   +------+-------+   +------+-------+
        |                  |                  |
        +------------------+------------------+
                           |
                  +--------+--------+
                  |   reins-gateway |
                  |   @reins/gateway|
                  +--------+--------+
                           |
                  +--------+--------+
                  |   reins-backend |
                  |   @reins/backend|
                  +--------+--------+
                           |
                  +--------+--------+
                  |     Convex      |
                  +-----------------+

         +-----------------------------------+
         |             reins-sdk             |
         |            @reins/sdk             |
         | Plugin APIs and developer tooling |
         +-----------------------------------+
```

## Repository Responsibilities

- `reins-core`: shared TypeScript conversation harness, provider interfaces, memory, and plugin contracts.
- `reins-tui`: terminal application powered by OpenTUI.
- `reins-desktop`: desktop app shell using Tauri v2.
- `reins-mobile`: mobile app shell using React Native.
- `reins-gateway`: model gateway and usage/billing boundary.
- `reins-backend`: Convex functions and product data services.
- `reins-sdk`: plugin developer SDK and scaffolding utilities.

## Decision Records Summary

- DG1 (Backend): Convex selected for reactive data and serverless function model.
- DG2 (Auth): Clerk selected for multi-platform auth and organization support.
- DG3 (Design System): Hybrid design system selected (shared tokens + headless UI logic, platform-specific rendering).

## Data Flow

1. Platform apps (`reins-tui`, `reins-desktop`, `reins-mobile`) call shared logic in `@reins/core`.
2. `@reins/core` routes model operations through `reins-gateway` for gateway-backed usage, or to configured provider adapters.
3. App data operations flow from `@reins/core` to `reins-backend` APIs backed by Convex.
4. Auth context is provided by Clerk and used across platform and backend boundaries.
5. Plugin authors build against `@reins/sdk`, which targets stable interfaces in `@reins/core`.

## Cross-Repo Dependency Graph

```text
reins-core        (source of shared contracts)
   ^
   |
   +-- reins-tui
   +-- reins-desktop
   +-- reins-mobile
   +-- reins-gateway
   +-- reins-backend
   +-- reins-sdk

reins-sdk  -> depends on reins-core plugin contracts
platforms  -> depend on reins-core runtime APIs
services   -> integrate with reins-core shared types
```
