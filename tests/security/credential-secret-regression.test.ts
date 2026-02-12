import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREDENTIAL_ENCRYPTION_SECRET_ENV,
  getCredentialEncryptionSecretFilePath,
  resolveCredentialEncryptionSecret,
} from "../../src/providers/credentials/store";

describe("security/credential-secret-regression", () => {
  it("removes hardcoded daemon default encryption secret literal", async () => {
    const daemonSource = await Bun.file(join(import.meta.dir, "..", "..", "src", "daemon", "server.ts")).text();

    expect(daemonSource.includes("DEFAULT_ENCRYPTION_SECRET")).toBe(false);
    expect(daemonSource.includes("reins-daemon-default-secret")).toBe(false);
  });

  it("prefers explicit environment secret for credential encryption", () => {
    const secret = resolveCredentialEncryptionSecret({
      env: {
        [CREDENTIAL_ENCRYPTION_SECRET_ENV]: "env-provided-secret",
      },
    });

    expect(secret).toBe("env-provided-secret");
  });

  it("generates and persists a stable machine secret on first run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-credential-secret-"));
    const secretPath = join(directory, "credentials", "encryption.secret");

    try {
      const first = resolveCredentialEncryptionSecret({ filePath: secretPath, env: {} });
      const second = resolveCredentialEncryptionSecret({ filePath: secretPath, env: {} });
      const persisted = (await readFile(secretPath, "utf8")).trim();

      expect(first.length).toBeGreaterThan(20);
      expect(second).toBe(first);
      expect(persisted).toBe(first);

      if (process.platform !== "win32") {
        const secretStat = await stat(secretPath);
        const secretMode = secretStat.mode & 0o777;
        expect(secretMode).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails fast in production when configured env secret is empty", () => {
    expect(() =>
      resolveCredentialEncryptionSecret({
        nodeEnv: "production",
        env: {
          [CREDENTIAL_ENCRYPTION_SECRET_ENV]: "   ",
        },
      }),
    ).toThrow();
  });

  it("keeps secret path under daemon data root by default", () => {
    const secretPath = getCredentialEncryptionSecretFilePath();
    expect(secretPath.endsWith("credentials/encryption.secret") || secretPath.endsWith("credentials\\encryption.secret")).toBe(
      true,
    );
  });
});
