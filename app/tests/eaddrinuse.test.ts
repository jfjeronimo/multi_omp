import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { createGateway } from "../src/gateway";
import { MemoryNodeStore } from "../src/store";
import { startMockUpstream, type MockUpstream } from "./helpers/mock-upstream";

/**
 * Hold `port` in a child process for `holdMs`, then release it. A child is
 * required because the gateway's retry loop blocks the event loop (spinning
 * with Atomics.wait), so a same-process timer could not free the port in
 * time — exactly like the real scenario where a previous process exits and
 * the OS releases the socket.
 */
function holdPort(port: number, holdMs: number): { kill: () => void } {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import net from "node:net";\n` +
        `net.createServer().listen(${port}, "127.0.0.1", () => {});\n` +
        `setTimeout(() => process.exit(0), ${holdMs});`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return { kill: () => child.kill() };
}

/** Wait until the child has actually bound the port (poll a connect attempt). */
async function waitPortHeld(port: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = connect({ host: "127.0.0.1", port });
        s.once("connect", () => resolve(s));
        s.once("error", (e) => reject(e));
      });
      socket.destroy();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`port ${port} never held by child process`);
}

describe("EADDRINUSE recovery", () => {
  let mock: MockUpstream;
  const servers: Bun.Server<unknown>[] = [];
  const children: Array<{ kill: () => void }> = [];

  beforeAll(async () => {
    mock = await startMockUpstream();
  });

  afterAll(() => {
    for (const c of children) c.kill();
    for (const s of servers) s.stop(true);
    mock.server.stop(true);
  });

  test("node listener: occupied saved port is re-assigned and persisted", async () => {
    const store = new MemoryNodeStore();
    const occupied = 30610;
    const holder = holdPort(occupied, 2000);
    children.push(holder);
    await waitPortHeld(occupied);

    store.add({ id: "n1", name: "N1", url: mock.url, port: occupied });
    const gw = await createGateway({
      store,
      port: 0,
      hostname: "127.0.0.1",
      portRange: { first: 30200, last: 30299 },
    });
    servers.push(gw.server);

    // The boot loop recovered: either the retry loop won the saved port back
    // once the previous holder released it, or it re-assigned a new one and
    // persisted that. Either way the record must have a usable port.
    const updated = store.get("n1");
    expect(updated?.port).not.toBeUndefined();
    expect(updated?.port!).toBeGreaterThanOrEqual(30200);

    // The re-assigned listener actually proxies (mock 404s unknown paths).
    const res = await fetch(`http://127.0.0.1:${updated?.port}/api/health`);
    expect(res.status).toBe(404);
    gw.stop();
  });

  test("node listener: saved port still held after retry window -> re-assigned and persisted", async () => {
    // The holder keeps the port past the 15s retry window, so the boot loop
    // must give up on the saved port, allocate a new one, and persist it.
    const store = new MemoryNodeStore();
    const occupied = 30630;
    const holder = holdPort(occupied, 100_000);
    children.push(holder);
    await waitPortHeld(occupied);

    store.add({ id: "n2", name: "N2", url: mock.url, port: occupied });
    const gw = await createGateway({
      store,
      port: 0,
      hostname: "127.0.0.1",
      portRange: { first: 30200, last: 30299 },
    });
    servers.push(gw.server);

    // The holder keeps the saved port held for the full 100s, well past the
    // 15s retry window, so the boot loop MUST give up and re-assign a new
    // port. afterAll kills it.
    const updated = store.get("n2");
    expect(updated?.port).not.toBeUndefined();
    expect(updated?.port).not.toBe(occupied);

    // The re-assigned listener actually proxies.
    const res = await fetch(`http://127.0.0.1:${updated?.port}/api/health`);
    expect(res.status).toBe(404);
    gw.stop();
  }, 30_000);

  test("control plane: EADDRINUSE recovers once the previous process releases", async () => {
    const store = new MemoryNodeStore();
    const port = 30620;

    const holder = holdPort(port, 1500);
    children.push(holder);
    await waitPortHeld(port);

    // createGateway blocks the event loop while it retries; the child
    // releases the port on its own clock, so the bind must eventually win.
    const gw = await createGateway({
      store,
      port,
      hostname: "127.0.0.1",
      portRange: { first: 30200, last: 30299 },
    });
    servers.push(gw.server);

    expect(gw.server.port).toBe(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/nodes`);
    expect(res.status).toBe(200);
    gw.stop();
  });
});
