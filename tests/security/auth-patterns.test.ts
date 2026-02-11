import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { authMiddleware } from "../../../reins-gateway/src/middleware/auth";

const workspaceRoot = join(import.meta.dir, "..", "..", "..");

async function readWorkspaceFile(relativePath: string): Promise<string> {
  return readFile(join(workspaceRoot, relativePath), "utf8");
}

describe("security/auth-patterns", () => {
  it("rejects missing auth token in gateway middleware", async () => {
    const response = await authMiddleware(
      {
        request: new Request("http://localhost/v1/chat/completions", {
          method: "POST",
        }),
        params: {},
        startTime: Date.now(),
      },
      async () => new Response("ok", { status: 200 }),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string; authHint?: { mode?: string; tokenPrefix?: string } };
    expect(body.error).toBe("authentication_required");
    expect(body.authHint?.mode).toBe("machine-token");
    expect(body.authHint?.tokenPrefix).toBe("rm_");
  });

  it("contains explicit expired-session handling in backend auth validators", async () => {
    const validatorsSource = await readWorkspaceFile("reins-backend/convex/lib/validators.ts");

    expect(validatorsSource.includes("Session has expired")).toBe(true);
    expect(validatorsSource.includes("session.expiresAt <= Date.now()")).toBe(true);
    expect(validatorsSource.includes("session.isActive")).toBe(true);
  });

  it("contains user/session ownership checks for invalid user ids", async () => {
    const httpSource = await readWorkspaceFile("reins-backend/convex/http.ts");

    expect(httpSource.includes("Session does not belong to current user")).toBe(true);
    expect(httpSource.includes("validated.session.userId !== user._id")).toBe(true);
  });

  it("enforces plugin permission checks before data and capability access", async () => {
    const enforcementSource = await readWorkspaceFile("reins-core/src/plugins/enforcement.ts");

    expect(enforcementSource.includes("enforcePermission(this.checker, \"read_notes\", \"notes.list\")")).toBe(
      true,
    );
    expect(enforcementSource.includes("enforcePermission(this.checker, \"network_access\", action)")).toBe(true);
    expect(enforcementSource.includes("enforcePermission(this.checker, \"file_access\", action)")).toBe(true);
  });
});
