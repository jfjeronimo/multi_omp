/**
 * Smoke test against a REAL local omp-web instance at 127.0.0.1:30141.
 * Skips itself when the node is not reachable, so the suite stays green
 * on machines without one running.
 *
 * Verifies the port model end to end: the node's listener serves the REAL
 * omp-web byte-for-byte at the root of its own port, so the SPA's absolute
 * asset paths resolve natively.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGateway, type Gateway } from "../src/gateway";
import { MemoryNodeStore } from "../src/store";
import { checkNode } from "../src/upstream";

const REAL_URL = "http://127.0.0.1:30141";
const NODE_PORT = 30600;

describe("smoke: real omp-web", () => {
  let store: MemoryNodeStore;
  let gw: Gateway;
  let skipped = false;

  beforeAll(async () => {
    const probe = await checkNode({ id: "p", name: "p", url: REAL_URL }, 800);
    if (!probe.ok) {
      console.log(`[smoke] skipping: no omp-web at ${REAL_URL} (${probe.error ?? "unknown"})`);
      skipped = true;
      return;
    }
    store = new MemoryNodeStore();
    store.add({ id: "local", name: "Local", url: REAL_URL, port: NODE_PORT });
    gw = await createGateway({
      store,
      port: 0,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      portRange: { first: 30600, last: 30699 },
    });
  });

  afterAll(() => gw?.stop());

  test("node listener serves the real omp-web HTML unmodified", async () => {
    if (skipped) return;
    const res = await fetch(`http://127.0.0.1:${NODE_PORT}/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
    const html = await res.text();
    // It is the real omp-web document, not an error page.
    expect(html.toLowerCase()).toContain("<html");
    // No base tag, no overlay, no prefix rewriting — byte-for-byte passthrough.
    expect(html).not.toContain("<base");
    expect(html).not.toContain("multi-omp-overlay");
    // The document's own absolute asset paths must be intact.
    expect(html).toContain("/_next/");
  });

  test("a real asset from the node loads 200 through the proxy", async () => {
    if (skipped) return;
    const home = await (await fetch(`http://127.0.0.1:${NODE_PORT}/`)).text();
    const m = home.match(/href="\/_next\/static\/css\/[^"]+\.css"/);
    expect(m).not.toBeNull();
    const asset = m![0].slice(6, -1); // strip href=" ... "
    const res = await fetch(`http://127.0.0.1:${NODE_PORT}${asset}`);
    expect(res.status).toBe(200);
  });
});
