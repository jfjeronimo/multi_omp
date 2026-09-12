import { describe, expect, test } from "bun:test";
import { diagnosePortHeld } from "../src/ports";

/**
 * diagnosePortHeld reads /proc/net/tcp{,6} + /proc/[pid]/fd from inside the
 * current network namespace. It is intentionally defensive: a missing fd, an
 * unreadable cmdline, or a holder outside the namespace must degrade to a
 * generic (but still actionable) message, never throw. The assertions below
 * are deliberately conservative (hex port + docker/ss guidance) so the test
 * passes on any Linux box, regardless of whether the holder's fd is visible.
 */
describe("diagnosePortHeld", () => {
  test("reports a live listener and always prints the hex port + actionable steps", async () => {
    // 39600-39699: free of the mock-upstream range (39100-39599) and the
    // gateway suite's node/control ranges (30200-30299, 30500, 30800-30960).
    const port = 39600 + Math.floor(Math.random() * 100);
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
    try {
      const text = diagnosePortHeld(port, "127.0.0.1");

      // The header includes the decimal port and the greppable hex form.
      expect(text).toContain(`port ${port}`);
      expect(text).toContain(":" + port.toString(16));

      // Every line carries the runtime prefix.
      for (const line of text.split("\n")) {
        expect(line).toContain("multi-omp:");
      }

      // Fixed, always-present actionable guidance.
      expect(text).toContain("docker ps -a");
      expect(text).toContain("docker compose ps");
      expect(text).toContain("docker exec");
      expect(text).toContain("docker stop");
      expect(text).toContain(`ss -ltnp | grep :${port}`);

      // The socket is visible in /proc/net/tcp from the same namespace, so
      // the diagnostic must have found a holder entry for the inode — either
      // a pid/cmdline line, or the "no local process" fallback.
      expect(text).toMatch(/held by pid \d+|no process in this namespace/);
    } finally {
      server.stop(true);
    }
  });

  test("compresses IPv6 loopback listeners to ::1 in the socket line (RFC 5952)", async () => {
    // ::1 decodes from /proc/net/tcp6 as ::0000:0000:0000:0000:0000:0000:0000:0001
    // before display compression; the diagnostic must print the compressed form.
    const port = 39680 + Math.floor(Math.random() * 20);
    const server = Bun.serve({ port, hostname: "::1", fetch: () => new Response() });
    try {
      const text = diagnosePortHeld(port, "::1");
      expect(text).toContain("[v6] ::1:");
      expect(text).toContain("multi-omp:");
    } finally {
      server.stop(true);
    }
  });

  test("degrades to the outside-namespace message when nothing holds the port", () => {
    // Pick a port in the same free window and bind+stop immediately so no
    // socket remains: the diagnostic must not throw and must point at the
    // host instead of a local holder.
    const port = 39650 + Math.floor(Math.random() * 50);
    const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
    probe.stop(true);

    const text = diagnosePortHeld(port, "127.0.0.1");

    expect(text).toContain(":" + port.toString(16));
    expect(text).toContain("outside this network namespace");
    expect(text).toContain(`ss -ltnp | grep :${port}`);
    // Guidance is printed in every branch.
    expect(text).toContain("docker ps -a");
  });
});
