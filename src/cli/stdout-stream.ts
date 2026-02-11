type DrainListener = () => void;

export interface StdoutLike {
  write(chunk: string): boolean;
  once(event: "drain", listener: DrainListener): void;
  isTTY?: boolean;
}

export interface StdoutStreamRenderer {
  writeChunk(chunk: string): Promise<void>;
  complete(): Promise<void>;
  readonly isTTY: boolean;
}

function waitForDrain(stdout: StdoutLike): Promise<void> {
  return new Promise<void>((resolve) => {
    stdout.once("drain", resolve);
  });
}

export function createStdoutStreamRenderer(stdout: StdoutLike = process.stdout): StdoutStreamRenderer {
  let pendingDrain: Promise<void> | null = null;

  return {
    isTTY: Boolean(stdout.isTTY),
    async writeChunk(chunk: string): Promise<void> {
      if (chunk.length === 0) {
        return;
      }

      if (pendingDrain) {
        await pendingDrain;
        pendingDrain = null;
      }

      const canContinue = stdout.write(chunk);
      if (!canContinue) {
        pendingDrain = waitForDrain(stdout);
      }
    },
    async complete(): Promise<void> {
      if (pendingDrain) {
        await pendingDrain;
        pendingDrain = null;
      }
    },
  };
}
