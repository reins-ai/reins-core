import { describe, expect, it } from "bun:test";

import { benchmark, formatBenchmark } from "../../src/utils";

type State = {
  byId: Record<string, number>;
  order: string[];
  revision: number;
};

type Action =
  | { type: "upsert"; id: string; value: number }
  | { type: "remove"; id: string }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  if (action.type === "reset") {
    return { byId: {}, order: [], revision: state.revision + 1 };
  }

  if (action.type === "remove") {
    if (!(action.id in state.byId)) {
      return state;
    }

    const nextById = { ...state.byId };
    delete nextById[action.id];

    return {
      byId: nextById,
      order: state.order.filter((entry) => entry !== action.id),
      revision: state.revision + 1,
    };
  }

  const hadId = action.id in state.byId;
  return {
    byId: {
      ...state.byId,
      [action.id]: action.value,
    },
    order: hadId ? state.order : [...state.order, action.id],
    revision: state.revision + 1,
  };
}

function createInitialState(size: number): State {
  const byId: Record<string, number> = {};
  const order: string[] = [];

  for (let index = 0; index < size; index += 1) {
    const id = `item-${index}`;
    byId[id] = index;
    order.push(id);
  }

  return {
    byId,
    order,
    revision: 0,
  };
}

describe("performance: reducer", () => {
  it("measures 10000 rapid state updates", { timeout: 30_000 }, () => {
    const result = benchmark(
      "state reducer rapid updates (10000 dispatches)",
      () => {
        let state = createInitialState(1000);

        for (let index = 0; index < 10000; index += 1) {
          state = reducer(state, {
            type: "upsert",
            id: `item-${index % 2000}`,
            value: index,
          });
        }

        expect(state.revision).toBe(10000);
      },
      3,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(2000);
  });

  it("measures state snapshot creation performance", () => {
    const state = createInitialState(5000);

    const result = benchmark(
      "state snapshot creation (structuredClone)",
      () => {
        const snapshot = structuredClone(state);
        expect(snapshot.order).toHaveLength(5000);
      },
      30,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(100);
  });

  it("checks memory growth under sustained reducer load", { timeout: 30_000 }, () => {
    const beforeHeap = process.memoryUsage().heapUsed;
    let state = createInitialState(2000);

    for (let cycle = 0; cycle < 8; cycle += 1) {
      for (let index = 0; index < 1000; index += 1) {
        state = reducer(state, {
          type: "upsert",
          id: `item-${index % 2500}`,
          value: cycle + index,
        });
      }
    }

    const afterHeap = process.memoryUsage().heapUsed;
    const heapGrowthMb = (afterHeap - beforeHeap) / (1024 * 1024);

    console.info(`[perf] reducer memory growth: ${heapGrowthMb.toFixed(2)} MB`);

    expect(state.order.length).toBeLessThanOrEqual(2500);
    expect(heapGrowthMb).toBeLessThan(64);
  });
});
