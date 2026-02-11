import { err, ok, type Result } from "../result";
import { EncryptedFileKeychainFallback, type EncryptedFileKeychainFallbackOptions } from "./keychain-fallback";
import { SecurityError } from "./security-error";

const NOT_FOUND_EXIT_CODE = 44;

export interface KeychainProvider {
  get(service: string, account: string): Promise<Result<string | null, SecurityError>>;
  set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>>;
  delete(service: string, account: string): Promise<Result<void, SecurityError>>;
}

export interface NativeCommandRunner {
  run(command: string, args: string[]): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, SecurityError>>;
}

class BunCommandRunner implements NativeCommandRunner {
  public async run(
    command: string,
    args: string[],
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, SecurityError>> {
    try {
      const processResult = Bun.spawn([command, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processResult.stdout).text(),
        new Response(processResult.stderr).text(),
        processResult.exited,
      ]);

      return ok({ stdout, stderr, exitCode });
    } catch (error) {
      return err(
        new SecurityError(
          `Unable to execute native keychain command: ${command}`,
          "SECURITY_NATIVE_COMMAND_EXEC_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

function isLikelyNotFound(platform: NodeJS.Platform, exitCode: number, output: string): boolean {
  const normalized = output.toLowerCase();

  if (platform === "darwin") {
    return exitCode === NOT_FOUND_EXIT_CODE || normalized.includes("could not be found");
  }

  if (platform === "linux") {
    return normalized.includes("no secret") || normalized.includes("not found");
  }

  if (platform === "win32") {
    return exitCode === 3;
  }

  return false;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function toWindowsTarget(service: string, account: string): string {
  return `${service}:${account}`;
}

export class NativeKeychainProvider implements KeychainProvider {
  private readonly platformDetector: () => NodeJS.Platform;
  private readonly commandRunner: NativeCommandRunner;

  constructor(options?: { platformDetector?: () => NodeJS.Platform; commandRunner?: NativeCommandRunner }) {
    this.platformDetector = options?.platformDetector ?? (() => process.platform);
    this.commandRunner = options?.commandRunner ?? new BunCommandRunner();
  }

  public async get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    const commandResult = await this.runPlatformCommand("get", service, account);
    if (!commandResult.ok) {
      return commandResult;
    }

    if (commandResult.value.exitCode !== 0) {
      if (
        isLikelyNotFound(
          this.platformDetector(),
          commandResult.value.exitCode,
          `${commandResult.value.stdout}\n${commandResult.value.stderr}`,
        )
      ) {
        return ok(null);
      }

      return err(
        new SecurityError(
          "Native keychain lookup failed",
          "SECURITY_NATIVE_GET_FAILED",
          new Error(commandResult.value.stderr || commandResult.value.stdout),
        ),
      );
    }

    const secret = commandResult.value.stdout.trim();
    return ok(secret.length > 0 ? secret : null);
  }

  public async set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    const commandResult = await this.runPlatformCommand("set", service, account, secret);
    if (!commandResult.ok) {
      return commandResult;
    }

    if (commandResult.value.exitCode !== 0) {
      return err(
        new SecurityError(
          "Native keychain write failed",
          "SECURITY_NATIVE_SET_FAILED",
          new Error(commandResult.value.stderr || commandResult.value.stdout),
        ),
      );
    }

    return ok(undefined);
  }

  public async delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    const commandResult = await this.runPlatformCommand("delete", service, account);
    if (!commandResult.ok) {
      return commandResult;
    }

    if (commandResult.value.exitCode !== 0) {
      if (
        isLikelyNotFound(
          this.platformDetector(),
          commandResult.value.exitCode,
          `${commandResult.value.stdout}\n${commandResult.value.stderr}`,
        )
      ) {
        return ok(undefined);
      }

      return err(
        new SecurityError(
          "Native keychain delete failed",
          "SECURITY_NATIVE_DELETE_FAILED",
          new Error(commandResult.value.stderr || commandResult.value.stdout),
        ),
      );
    }

    return ok(undefined);
  }

  private async runPlatformCommand(
    action: "get" | "set" | "delete",
    service: string,
    account: string,
    secret?: string,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, SecurityError>> {
    const platform = this.platformDetector();

    if (platform === "darwin") {
      if (action === "get") {
        return this.commandRunner.run("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
      }

      if (action === "set") {
        return this.commandRunner.run("security", [
          "add-generic-password",
          "-a",
          account,
          "-s",
          service,
          "-w",
          secret ?? "",
          "-U",
        ]);
      }

      return this.commandRunner.run("security", ["delete-generic-password", "-a", account, "-s", service]);
    }

    if (platform === "linux") {
      if (action === "get") {
        return this.commandRunner.run("secret-tool", ["lookup", "service", service, "account", account]);
      }

      if (action === "set") {
        return this.commandRunner.run("secret-tool", [
          "store",
          "--label",
          "Reins Daemon Machine Secret",
          "service",
          service,
          "account",
          account,
          "--password",
          secret ?? "",
        ]);
      }

      return this.commandRunner.run("secret-tool", ["clear", "service", service, "account", account]);
    }

    if (platform === "win32") {
      const target = toWindowsTarget(service, account);
      const targetLiteral = quotePowerShell(target);

      if (action === "get") {
        return this.commandRunner.run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$c = Get-StoredCredential -Target ${targetLiteral} -ErrorAction SilentlyContinue; if ($null -eq $c) { exit 3 }; [Console]::Out.Write($c.Password)`,
        ]);
      }

      if (action === "set") {
        const secretLiteral = quotePowerShell(secret ?? "");
        const userLiteral = quotePowerShell(account);
        return this.commandRunner.run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `New-StoredCredential -Target ${targetLiteral} -UserName ${userLiteral} -Password ${secretLiteral} -Persist LocalMachine | Out-Null`,
        ]);
      }

      return this.commandRunner.run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Remove-StoredCredential -Target ${targetLiteral} -ErrorAction SilentlyContinue | Out-Null`,
      ]);
    }

    return err(new SecurityError(`Unsupported platform: ${platform}`, "SECURITY_PLATFORM_UNSUPPORTED"));
  }
}

export class EncryptedFileKeychainProvider implements KeychainProvider {
  constructor(private readonly fallback = new EncryptedFileKeychainFallback()) {}

  public get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    return this.fallback.read(service, account);
  }

  public set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    return this.fallback.write(service, account, secret);
  }

  public delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    return this.fallback.remove(service, account);
  }
}

export class AutoDetectKeychainProvider implements KeychainProvider {
  constructor(
    private readonly nativeProvider: KeychainProvider,
    private readonly fallbackProvider: KeychainProvider,
  ) {}

  public async get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    const nativeResult = await this.nativeProvider.get(service, account);
    if (nativeResult.ok) {
      if (nativeResult.value !== null) {
        return nativeResult;
      }

      return this.fallbackProvider.get(service, account);
    }

    return this.fallbackProvider.get(service, account);
  }

  public async set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    const nativeResult = await this.nativeProvider.set(service, account, secret);
    if (nativeResult.ok) {
      return nativeResult;
    }

    return this.fallbackProvider.set(service, account, secret);
  }

  public async delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    const nativeResult = await this.nativeProvider.delete(service, account);
    const fallbackResult = await this.fallbackProvider.delete(service, account);

    if (nativeResult.ok || fallbackResult.ok) {
      return ok(undefined);
    }

    return fallbackResult;
  }
}

export interface CreateKeychainProviderOptions {
  nativeProvider?: KeychainProvider;
  fallbackProvider?: KeychainProvider;
  fallbackOptions?: EncryptedFileKeychainFallbackOptions;
}

export function createKeychainProvider(options: CreateKeychainProviderOptions = {}): KeychainProvider {
  const nativeProvider = options.nativeProvider ?? new NativeKeychainProvider();
  const fallbackProvider =
    options.fallbackProvider ?? new EncryptedFileKeychainProvider(new EncryptedFileKeychainFallback(options.fallbackOptions));

  return new AutoDetectKeychainProvider(nativeProvider, fallbackProvider);
}
