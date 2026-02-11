import { runSetupWizard, type RunSetupWizardOptions } from "../setup-wizard";

type WriteFn = (text: string) => void;

export type RunSetupFn = (args?: string[]) => Promise<number>;

export interface SetupCommandDeps {
  runWizard: (options?: RunSetupWizardOptions) => Promise<{
    status: "completed" | "cancelled" | "error";
    message: string;
  }>;
  writeStdout: WriteFn;
  writeStderr: WriteFn;
}

export interface SetupCommandFlags {
  reset: boolean;
}

export function parseSetupFlags(args: string[]): SetupCommandFlags {
  let reset = false;

  for (const arg of args) {
    if (arg === "--reset") {
      reset = true;
    }
  }

  return { reset };
}

export async function runSetup(args: string[] = [], customDeps: Partial<SetupCommandDeps> = {}): Promise<number> {
  const deps: SetupCommandDeps = {
    runWizard: customDeps.runWizard ?? runSetupWizard,
    writeStdout: customDeps.writeStdout ?? process.stdout.write.bind(process.stdout),
    writeStderr: customDeps.writeStderr ?? process.stderr.write.bind(process.stderr),
  };

  const flags = parseSetupFlags(args);
  const result = await deps.runWizard({ reset: flags.reset });

  if (result.status === "completed") {
    deps.writeStdout(`${result.message}\n`);
    return 0;
  }

  if (result.status === "cancelled") {
    deps.writeStderr(`${result.message}\n`);
    return 130;
  }

  deps.writeStderr(`Setup failed: ${result.message}\n`);
  return 1;
}
