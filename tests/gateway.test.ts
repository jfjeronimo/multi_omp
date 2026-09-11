import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGateway, type Gateway } from "../src/gateway";
import { MemoryNodeStore } from "../src/store";
import { checkNode } from "../src/upstream";
import { startMockUpstream, type MockUpstream } from "./helpers/mock-upstream";

describe("gateway", () => {
  let mock: MockUpstream;
  let mock2: MockUpstream;
  let store: MemoryNodeStore;
  let gw: Gateway;
  let nodePort: number;

  beforeAll(async () => {
    mock = await startMockUpstream({ locked: true });
    mock2 = await startMockUpstream();
    store = new MemoryNodeStore();
    // Pre-allocate a fixed port so the test can hit the node listener directly.
    store.add({ id: "rasp", name: "Raspberry", url: mock.url, password: "mock-pass", port: 30500 });
    nodePort = 30500;
    gw = createGateway({
      store,
      port: 0,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      portRange: { first: 30200, last: 30299 },
    });
  });

  afterAll(() => {
    gw.stop();
    mock.server.stop(true);
    mock2.server.stop(true);
  });

  test("dashboard renders with node, status and local url", async () => {
    const res = await gw.handle(new Request("http://gw/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("multi-omp");
    expect(html).toContain("Raspberry");
    expect(html).toContain(`http://127.0.0.1:${nodePort}/`);
    expect(html).toContain('data-id="rasp"');
  });

  test("GET /api/nodes/:id returns node without password", async () => {
    const res = await gw.handle(new Request("http://gw/api/nodes/rasp"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      node: Record<string, unknown>;
      status: { ok: boolean };
    };
    expect(body.node.id).toBe("rasp");
    expect(body.node.password).toBeUndefined();
    expect(body.node.hasPassword).toBe(true);
    expect(body.status.ok).toBe(true);
  });

  test("unknown node -> 404", async () => {
    const res = await gw.handle(new Request("http://gw/api/nodes/nope"));
    expect(res.status).toBe(404);
  });

  test("POST /api/nodes/:id -> 405 (updates are PATCH)", async () => {
    const res = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Raspberry" }),
      }),
    );
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toBe("Method not allowed");
  });

  test("POST /api/nodes adds a node and allocates a port in range", async () => {
    const res = await gw.handle(
      new Request("http://gw/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Pi", url: `http://127.0.0.1:${mock.port}` }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { id: string; port: number } };
    expect(body.node.id).toBe("pi");
    expect(body.node.port).toBeGreaterThanOrEqual(30200);
    expect(body.node.port).toBeLessThanOrEqual(30299);
    expect(store.get("pi")).toBeDefined();
  });

  test("POST /api/nodes validates input", async () => {
    const bad = await gw.handle(
      new Request("http://gw/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "", url: "" }),
      }),
    );
    expect(bad.status).toBe(400);
    const notjson = await gw.handle(new Request("http://gw/api/nodes", { method: "POST", body: "not json" }));
    expect(notjson.status).toBe(400);
  });

  test("PATCH updates a node", async () => {
    const res = await gw.handle(
      new Request("http://gw/api/nodes/pi", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Pi 5", note: "the good one" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { node: { name: string; note?: string } };
    expect(body.node.name).toBe("Pi 5");
    expect(body.node.note).toBe("the good one");
  });

  test("DELETE removes a node and stops its listener", async () => {
    const res = await gw.handle(new Request("http://gw/api/nodes/pi", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get("pi")).toBeUndefined();
  });

  test("node listener proxies HTML unmodified (no base/overlay)", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("MOCK APP");
    // The whole point of the port model: no prefix rewriting, no base tag, no overlay.
    expect(html).not.toContain("<base");
    expect(html).not.toContain("multi-omp-overlay");
    const last = mock.requests[mock.requests.length - 1];
    expect(last.host).toBe(`127.0.0.1:${mock.port}`);
    expect(last.auth).toBe(`Basic ${Buffer.from("omp:mock-pass").toString("base64")}`);
  });

  test("node listener proxies static asset unchanged", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/_next/static/chunks/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log('main')");
  });

  test("node listener proxies JSON api", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/api/sessions`);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ sessions: ["s1", "s2"] });
  });

  test("node listener proxies SSE stream", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/api/agent/1/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: connected");
    expect(text).toContain("hello");
  });

  test("node listener passes upstream 404 through", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/nope`);
    expect(res.status).toBe(404);
  });

  test("gateway 404s unknown top-level routes", async () => {
    expect((await gw.handle(new Request("http://gw/unknown"))).status).toBe(404);
  });
  test("GET /api/nodes lists nodes without passwords", async () => {
    const res = await gw.handle(new Request("http://gw/api/nodes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Record<string, unknown>[] };
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe("rasp");
    expect(body.nodes[0].password).toBeUndefined();
    expect(body.nodes[0].hasPassword).toBe(true);
  });

  test("invalid id segment -> 400", async () => {
    expect((await gw.handle(new Request("http://gw/api/nodes/BAD_ID"))).status).toBe(400);
    expect((await gw.handle(new Request("http://gw/api/nodes/-bad"))).status).toBe(400);
  });

  test("PATCH url change redirects to the new origin without rebind", async () => {
    // Point the node at mock2; the listener must keep its port and proxy
    // to the new origin immediately (fresh per-request store read).
    const res = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock2.url }),
      }),
    );
    expect(res.status).toBe(200);
    expect(store.get("rasp")?.port).toBe(nodePort);
    const before = mock2.requests.length;
    const html = await (await fetch(`http://127.0.0.1:${nodePort}/`)).text();
    expect(html).toContain("MOCK APP");
    expect(mock2.requests.slice(before).length).toBeGreaterThan(0);
    // Restore the original origin for the tests that follow.
    await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url }),
      }),
    );
  });

  test("PATCH credential change takes effect immediately", async () => {
    const before = mock.requests.length;
    const res = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "omp", password: "mock-pass" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${nodePort}/`)).status).toBe(200);
    expect(mock.requests[before + 1]?.auth).toBe(`Basic ${Buffer.from("omp:mock-pass").toString("base64")}`);
  });

  test("PATCH password:null clears credentials", async () => {
    mock.setLocked(false);
    const res = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { node: { hasPassword: boolean } }).node.hasPassword).toBe(false);
    expect(store.get("rasp")?.password).toBeUndefined();
    const before = mock.requests.length;
    expect((await fetch(`http://127.0.0.1:${nodePort}/`)).status).toBe(200);
    expect(mock.requests[before]?.auth).toBe(null);
    // restore locked state + password for subsequent tests
    const restore = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "mock-pass" }),
      }),
    );
    expect(restore.status).toBe(200);
    mock.setLocked(true);
  });

  test("PATCH username:null clears username (defaults to omp)", async () => {
    const before = mock.requests.length;
    const res = await gw.handle(
      new Request("http://gw/api/nodes/rasp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${nodePort}/`)).status).toBe(200);
    expect(mock.requests[before + 1]?.auth).toBe(`Basic ${Buffer.from("omp:mock-pass").toString("base64")}`);
  });
});
