# Performance Baseline - Reins v0.1.0

## Environment

- Runtime: Bun 1.x
- Test Machine: `linux x64` (Bun `1.3.5`)
- Benchmark command: `bun test tests/performance`

## Benchmarks

### Streaming

| Operation | Avg (ms) | P95 (ms) | Ops/sec |
|-----------|----------|----------|---------|
| Token processing | 1.453 | 4.420 | 688.053 |
| Stream event dispatch | 1.155 | 2.172 | 865.510 |

### Conversation

| Operation | Avg (ms) | P95 (ms) | Notes |
|-----------|----------|----------|-------|
| 100 messages load | 0.130 | 0.417 | |
| 500 messages load | 0.430 | 0.516 | |
| 1000 messages load | 0.900 | 1.186 | |
| Message search (1000 messages) | 0.035 | 0.042 | |
| Serialization/deserialization (1000 messages) | 1.084 | 1.528 | |

### Plugin

| Operation | Avg (ms) | P95 (ms) | Ops/sec |
|-----------|----------|----------|---------|
| Manifest validation | 0.133 | 0.213 | 7529.709 |
| Tool registration | 0.038 | 0.051 | 26618.923 |
| Tool execution (mock) | 0.287 | 0.349 | 3479.765 |

### State Management

| Operation | Avg (ms) | P95 (ms) | Notes |
|-----------|----------|----------|-------|
| 10000 rapid updates | 867.896 | 907.166 | Immutable reducer workload; stress benchmark |
| State snapshot creation | 1.587 | 2.499 | `structuredClone` on 5K-item state |
| Memory growth under sustained load | N/A | N/A | +3.54 MB in test run |

## Optimization Notes

- Baseline instrumentation added in `tests/performance` to capture repeatable metrics for core hotspots.
- Reducer stress benchmark is significantly slower than other paths (~0.868s per 10K immutable dispatches), but this is an intentionally heavy synthetic stress case and not a user-facing hot path in `reins-core`.
- No critical production bottleneck was identified during this task; no production logic changes were required.
- Future opportunity: track time-to-first-token in integration tests with provider mocks and compare against real provider telemetry.
- Future opportunity: add CI trend reporting for perf medians and p95 regressions.

## How To Run

From `reins-core`:

```bash
bun run typecheck
bun test
```

Performance test suites print benchmark summaries to stdout. Re-run and refresh this file whenever runtime, architecture, or core data-flow behavior changes.
