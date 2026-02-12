import { describe, expect, it } from "bun:test";

import { StreamingResponse } from "../../src/streaming";
import type { StreamEvent } from "../../src/types";
import { benchmarkAsync, formatBenchmark } from "../../src/utils";

const TOKEN_COUNT = 1000;

async function* tokenStream(count: number): AsyncIterable<StreamEvent> {
  for (let index = 0; index < count; index += 1) {
    yield { type: "token", content: "x" };
  }

  yield {
    type: "done",
    usage: {
      inputTokens: 0,
      outputTokens: count,
      totalTokens: count,
    },
    finishReason: "stop",
  };
}

describe("performance: streaming", () => {
  it("prints benchmark environment details", () => {
    console.info(
      `[perf] environment platform=${process.platform} arch=${process.arch} bun=${Bun.version}`,
    );
    expect(typeof Bun.version).toBe("string");
  });

  it("measures token processing throughput", async () => {
    const result = await benchmarkAsync(
      "streaming token processing (1000 tokens)",
      async () => {
        const response = new StreamingResponse(tokenStream(TOKEN_COUNT));
        let processed = 0;

        for await (const event of response) {
          if (event.type === "token") {
            processed += 1;
          }
        }

        expect(processed).toBe(TOKEN_COUNT);
      },
      10,
    );

    console.info(formatBenchmark(result));

    const averagePerTokenMs = result.averageMs / TOKEN_COUNT;
    if (averagePerTokenMs > 1) {
      console.warn(
        `[perf] Soft target missed: token processing average ${averagePerTokenMs.toFixed(4)}ms/token`,
      );
    }

    expect(averagePerTokenMs).toBeLessThan(5);
  });

  it("measures stream event dispatch latency", async () => {
    const result = await benchmarkAsync(
      "streaming dispatch latency (callbacks)",
      async () => {
        let callbackTokenCount = 0;
        const response = new StreamingResponse(tokenStream(TOKEN_COUNT)).onToken(() => {
          callbackTokenCount += 1;
        });

        await response.collect();
        expect(callbackTokenCount).toBe(TOKEN_COUNT);
      },
      10,
    );

    console.info(formatBenchmark(result));

    const dispatchPerTokenMs = result.averageMs / TOKEN_COUNT;
    expect(dispatchPerTokenMs).toBeLessThan(5);
  });
});
