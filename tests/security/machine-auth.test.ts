import { describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  EncryptedFileKeychainProvider,
  MachineAuthService,
  type KeychainProvider,
  type MachineAuthAuditSignal,
  SecurityError,
} from "../../src";
import { err, ok } from "../../src/result";
import { EncryptedFileKeychainFallback } from "../../src/security/keychain-fallback";

class InMemoryKeychainProvider implements KeychainProvider {
  private readonly storage = new Map<string, string>();

  public get(service: string, account: string) {
    return Promise.resolve(ok(this.storage.get(`${service}:${account}`) ?? null));
  }

  public set(service: string, account: string, secret: string) {
    this.storage.set(`${service}:${account}`, secret);
    return Promise.resolve(ok(undefined));
  }

  public delete(service: string, account: string) {
    this.storage.delete(`${service}:${account}`);
    return Promise.resolve(ok(undefined));
  }
}

class FailingKeychainProvider implements KeychainProvider {
  public get() {
    return Promise.resolve(err(new SecurityError("failed", "SECURITY_FAKE_FAILURE")));
  }

  public set() {
    return Promise.resolve(err(new SecurityError("failed", "SECURITY_FAKE_FAILURE")));
  }

  public delete() {
    return Promise.resolve(err(new SecurityError("failed", "SECURITY_FAKE_FAILURE")));
  }
}

function createTempDirectory(prefix: string): string {
  return `/tmp/${prefix}-${crypto.randomUUID()}`;
}

describe("MachineAuthService", () => {
  it("bootstraps once and reuses existing token", async () => {
    const service = new MachineAuthService({ provider: new InMemoryKeychainProvider() });

    const first = await service.bootstrap();
    const second = await service.bootstrap();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok) {
      expect(first.value).toBe(second.value);
      expect(first.value.startsWith("rm_")).toBe(true);
      expect(first.value.length).toBe(67);
    }
  });

  it("validates and rotates machine token", async () => {
    const service = new MachineAuthService({ provider: new InMemoryKeychainProvider() });
    const initial = await service.bootstrap();
    expect(initial.ok).toBe(true);

    if (!initial.ok) {
      return;
    }

    const accepted = await service.validate(initial.value);
    expect(accepted).toEqual({ ok: true, value: true });

    const rotated = await service.rotate();
    expect(rotated.ok).toBe(true);

    if (!rotated.ok) {
      return;
    }

    const oldTokenRejected = await service.validate(initial.value);
    const newTokenAccepted = await service.validate(rotated.value);

    expect(oldTokenRejected).toEqual({ ok: true, value: false });
    expect(newTokenAccepted).toEqual({ ok: true, value: true });
  });

  it("revokes token and rejects validation after revocation", async () => {
    const service = new MachineAuthService({ provider: new InMemoryKeychainProvider() });
    const bootstrapped = await service.bootstrap();
    expect(bootstrapped.ok).toBe(true);

    if (!bootstrapped.ok) {
      return;
    }

    const revokeResult = await service.revoke();
    expect(revokeResult).toEqual({ ok: true, value: undefined });

    const validation = await service.validate(bootstrapped.value);
    expect(validation).toEqual({ ok: true, value: false });

    const tokenResult = await service.getToken();
    expect(tokenResult.ok).toBe(false);
    if (!tokenResult.ok) {
      expect(tokenResult.error.code).toBe("MACHINE_AUTH_NOT_BOOTSTRAPPED");
    }
  });

  it("emits audit signals for bootstrap, rejection, and revocation", async () => {
    const signals: MachineAuthAuditSignal[] = [];
    const service = new MachineAuthService({
      provider: new InMemoryKeychainProvider(),
      onAuditSignal: (signal) => {
        signals.push(signal);
      },
    });

    const bootstrapped = await service.bootstrap();
    expect(bootstrapped.ok).toBe(true);

    await service.validate("rm_deadbeef");
    await service.revoke();

    expect(signals.some((signal) => signal.type === "auth.bootstrap.created")).toBe(true);
    expect(signals.some((signal) => signal.type === "auth.validation.rejected")).toBe(true);
    expect(signals.some((signal) => signal.type === "auth.revocation.completed")).toBe(true);
  });

  it("returns provider errors via Result", async () => {
    const service = new MachineAuthService({ provider: new FailingKeychainProvider() });

    const result = await service.bootstrap();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_FAKE_FAILURE");
      expect(result.error).toBeInstanceOf(SecurityError);
    }
  });
});

describe("EncryptedFileKeychainProvider", () => {
  it("persists encrypted fallback payload with secure file permissions", async () => {
    const tempDir = createTempDirectory("reins-machine-auth");
    const fallbackPath = join(tempDir, "machine-secret.enc");
    const provider = new EncryptedFileKeychainProvider(
      new EncryptedFileKeychainFallback({
        filePath: fallbackPath,
        keyMaterial: "unit-test-key",
      }),
    );

    const service = new MachineAuthService({
      provider,
      serviceName: "com.reins.test",
      accountName: "machine-secret",
    });

    const tokenResult = await service.bootstrap();
    expect(tokenResult.ok).toBe(true);

    if (!tokenResult.ok) {
      return;
    }

    const loaded = await service.getToken();
    expect(loaded).toEqual({ ok: true, value: tokenResult.value });

    const fileText = await Bun.file(fallbackPath).text();
    expect(fileText.includes(tokenResult.value)).toBe(false);

    const metadata = await stat(fallbackPath);
    expect(metadata.mode & 0o777).toBe(0o600);
  });
});
