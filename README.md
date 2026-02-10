# reins-core

Shared TypeScript core for Reins: conversation engine, memory, provider abstraction, and plugin API.

## Setup

1. Install Bun: https://bun.sh
2. Install dependencies:

```bash
bun install
```

3. Run checks:

```bash
bun run typecheck
bun test
```

## Local linking workflow

Use this package as a local dependency in downstream repos:

```bash
bun link
```

Then in another Reins repo:

```bash
bun link @reins/core
```
