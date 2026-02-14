import { describe, expect, it } from "bun:test";

import { TransportProbe } from "../../src/daemon/transport-probe";

const WARNING_MESSAGE =
  "Connection is unencrypted. Consider using Tailscale or Cloudflare Tunnel for secure remote access.";

function createMockFetch(headers: Record<string, string> = {}) {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(null, { headers });
  };
}

describe("TransportProbe", () => {
  describe("localhost detection", () => {
    it("detects 127.0.0.1 as localhost", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://127.0.0.1:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("localhost");
    });

    it("detects ::1 as localhost", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://[::1]:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("localhost");
    });

    it("detects localhost hostname as localhost", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://localhost:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("localhost");
    });

    it("detects 0.0.0.0 as localhost", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://0.0.0.0:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("localhost");
    });

    it("localhost is not encrypted", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://localhost:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.encrypted).toBe(false);
    });

    it("localhost has no warning", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://localhost:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warning).toBeUndefined();
    });
  });

  describe("Tailscale detection", () => {
    it("detects 100.64.0.1 as tailscale (CGNAT start)", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.64.0.1:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("tailscale");
    });

    it("detects 100.127.255.255 as tailscale (CGNAT end)", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.127.255.255:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("tailscale");
    });

    it("detects 100.100.100.100 as tailscale (mid-range)", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.100.100.100:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("tailscale");
    });

    it("does NOT detect 100.63.x.x as tailscale (below range)", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.63.10.2:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("direct");
    });

    it("does NOT detect 100.128.x.x as tailscale (above range)", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.128.10.2:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("direct");
    });

    it("detects *.ts.net hostname as tailscale", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://device.ts.net:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("tailscale");
    });

    it("detects myhost.tail12345.ts.net as tailscale", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://myhost.tail12345.ts.net:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("tailscale");
    });

    it("tailscale is encrypted", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://100.64.0.1:7433");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.encrypted).toBe(true);
    });
  });

  describe("Cloudflare detection", () => {
    it("detects *.trycloudflare.com as cloudflare", async () => {
      const probe = new TransportProbe({
        fetchFn: createMockFetch(),
      });
      const result = await probe.detect("https://example.trycloudflare.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("cloudflare");
    });

    it("detects CF-Ray header as cloudflare", async () => {
      let method: string | undefined;
      const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
        method = init?.method;
        return new Response(null, {
          headers: {
            "cf-ray": "abc123",
          },
        });
      };

      const probe = new TransportProbe({ fetchFn });
      const result = await probe.detect("https://abc.trycloudflare.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(method).toBe("HEAD");
      expect(result.value.type).toBe("cloudflare");
    });

    it("cloudflare is encrypted", async () => {
      const probe = new TransportProbe({ fetchFn: createMockFetch() });
      const result = await probe.detect("https://test.trycloudflare.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("cloudflare");
      expect(result.value.encrypted).toBe(true);
    });
  });

  describe("direct detection", () => {
    it("classifies unknown hostname as direct", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("https://example.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("direct");
    });

    it("https direct is encrypted", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("https://example.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.encrypted).toBe(true);
      expect(result.value.warning).toBeUndefined();
    });

    it("http direct is not encrypted with warning", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://example.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.encrypted).toBe(false);
      expect(result.value.warning).toBe(WARNING_MESSAGE);
    });

    it("warning message mentions Tailscale and Cloudflare", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("http://example.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warning).toContain("Tailscale");
      expect(result.value.warning).toContain("Cloudflare");
    });
  });

  describe("edge cases", () => {
    it("handles malformed URL gracefully", async () => {
      const probe = new TransportProbe();
      const result = await probe.detect("not-a-url");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("direct");
      expect(result.value.encrypted).toBe(false);
      expect(result.value.warning).toBe(WARNING_MESSAGE);
    });

    it("handles probe timeout gracefully (falls back to hostname analysis)", async () => {
      const fetchFn = async () => {
        throw new Error("timeout");
      };

      const probe = new TransportProbe({ fetchFn, timeout: 1 });
      const result = await probe.detect("https://slow.trycloudflare.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("cloudflare");
      expect(result.value.encrypted).toBe(true);
    });

    it("handles network error gracefully", async () => {
      const fetchFn = async () => {
        throw new Error("network");
      };

      const probe = new TransportProbe({ fetchFn });
      const result = await probe.detect("https://offline.trycloudflare.com");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("cloudflare");
      expect(result.value.encrypted).toBe(true);
    });
  });
});
