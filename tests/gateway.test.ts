import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { createGateway, type Gateway } from "../src/gateway";
import { resolveBindHost } from "../src/ports";
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
    gw = await createGateway({
      store,
      port: 0,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      notifierIntervalMs: 0,
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
    // The allocated port is persisted on the record, so GET /api/nodes/:id
    // (and the switcher bar) can reach the node's proxy origin.
    const oneRes = await gw.handle(new Request("http://gw/api/nodes/pi"));
    const one = (await oneRes.json()) as { node: { port: number } };
    expect(one.node.port).toBe(body.node.port);
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

  test("node listener injects the switcher bar into root HTML only", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("MOCK APP");
    // The bar is appended before </body>; the app itself is unmodified.
    expect(html).toContain('id="momo-bar"');
    expect(html).toContain('var ME = "rasp";');
    expect(html.indexOf("MOCK APP")).toBeLessThan(html.indexOf('id="momo-bar"'));
    // Still no prefix rewriting / base tag / dashboard overlay.
    expect(html).not.toContain("<base");
    expect(html).not.toContain("multi-omp-overlay");
    // The node page's own favicon links are replaced with the gateway's,
    // so the tab icon is the multi-omp mark while viewing a node.
    const gwOrigin = `http://127.0.0.1:${gw.server.port}`;
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${gwOrigin}/favicon.svg">`);
    expect(html).not.toContain('href="/favicon.ico"');
    // Hidden bar must be recoverable: restore chip present, wired to un-hide.
    expect(html).toContain('id="momo-restore"');
    expect(html).toContain('localStorage.removeItem("momo-bar-hidden")');
    const last = mock.requests[mock.requests.length - 1];
    expect(last.host).toBe(`127.0.0.1:${mock.port}`);
    expect(last.auth).toBe(`Basic ${Buffer.from("omp:mock-pass").toString("base64")}`);
  });

  test("gateway serves the multi-omp favicon at /favicon.ico and /favicon.svg", async () => {
    for (const path of ["/favicon.ico", "/favicon.svg"]) {
      const res = await gw.handle(new Request(`http://gw${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      const body = await res.text();
      expect(body).toContain("<svg");
      expect(body).toContain("mompig");
    }
  });

  test("node listener rewrites browser Origin to the node origin on api calls", async () => {
    const before = mock.requests.length;
    const res = await fetch(`http://127.0.0.1:${nodePort}/api/agent/1`, {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "hello" }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${nodePort}`,
      },
    });
    // /api/agent/1 (no /events) is unknown to the mock -> 404, which proves
    // the request reached the upstream instead of being rejected at host trust.
    expect(res.status).toBe(404);
    const last = mock.requests[mock.requests.length - 1];
    expect(last.path).toBe("/api/agent/1");
    expect(last.origin).toBe(mock.url);
    expect(mock.requests.length).toBe(before + 1);
  });

  test("node listener proxies static asset unchanged", async () => {
    const res = await fetch(`http://127.0.0.1:${nodePort}/_next/static/chunks/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log('main')");
    expect(await (await fetch(`http://127.0.0.1:${nodePort}/_next/static/chunks/main.js`)).text()).not.toContain("momo-bar");
  });

  test("node listener leaves api and sse responses bar-free", async () => {
    expect((await (await fetch(`http://127.0.0.1:${nodePort}/api/sessions`)).text()).includes("momo-bar")).toBe(false);
    const sse = await (await fetch(`http://127.0.0.1:${nodePort}/api/agent/1/events`)).text();
    expect(sse).not.toContain("momo-bar");
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

  test("node saved on the control-plane port is re-assigned, not crashed", async () => {
    // Regression: a stale nodes.json can carry the gateway port (e.g. 30140).
    // Boot must drop the poisoned port and allocate a fresh one instead of
    // failing the whole gateway with EADDRINUSE.
    const gwPort = 30900;
    const store2 = new MemoryNodeStore();
    store2.add({ id: "collide", name: "Collide", url: mock2.url, port: gwPort });
    const gw2 = await createGateway({
      store: store2,
      port: gwPort,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      notifierIntervalMs: 0,
      portRange: { first: 30800, last: 30810 },
    });
    try {
      const node = store2.get("collide");
      expect(node?.port).toBeDefined();
      expect(node?.port).not.toBe(gwPort);
      expect(node?.port).toBeGreaterThanOrEqual(30800);
      expect(node?.port).toBeLessThanOrEqual(30810);
      const res = await fetch(`http://127.0.0.1:${node?.port}/`);
      expect(res.status).toBe(200);
      // The dashboard itself is still reachable on the control-plane port.
      const dash = await fetch(`http://127.0.0.1:${gwPort}/api/health`);
      expect(dash.status).toBe(200);
    } finally {
      gw2.stop();
    }
  });

  test("POST /api/nodes never allocates the control-plane port", async () => {
    // Contract: the gateway port can fall inside the node range; the
    // allocator must never hand it out. (The range-skip in pickPort is
    // defense-in-depth over probePortFree, which already detects the
    // bound control plane; the explicit-port guard + ensureNodeServer
    // self-heal are the load-bearing fix, covered by the test above.)
    const gwPort = 30950;
    const store3 = new MemoryNodeStore();
    const gw3 = await createGateway({
      store: store3,
      port: gwPort,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      notifierIntervalMs: 0,
      portRange: { first: 30940, last: 30960 },
    });
    try {
      const res = await gw3.handle(
        new Request("http://gw/api/nodes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Range Node", url: mock2.url }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { node: { port: number } };
      expect(body.node.port).not.toBe(gwPort);
      expect(body.node.port).toBeGreaterThanOrEqual(30940);
      expect(body.node.port).toBeLessThanOrEqual(30960);
    } finally {
      gw3.stop();
    }
  });

  test("hostname bind target resolves to an IP and serves (no EADDRINUSE)", async () => {
    // Regression: a deployment can pass the machine FQDN (e.g. via
    // HOSTNAME_BIND) as the bind host. Bun.serve with a bare hostname
    // resolves it to the machine's IP — which inside a container is not an
    // address of the container's netns, so the kernel refuses the bind
    // (EADDRNOTAVAIL; some Bun versions report EADDRINUSE with errno 0)
    // and no socket ever appears in /proc. The gateway must resolve the
    // name to an IP literal up front and bind a local address instead.
    //
    // To exercise the FQDN path in every environment (bare hostnames in
    // Docker/CI have no dot, so os.hostname() is useless there), register
    // a synthetic name in /etc/hosts when writable; otherwise fall back to
    // a dotted os.hostname(); otherwise skip.
    const SYNTHETIC = "multi-omp-regression.invalid";
    const entry = `127.0.0.1\t${SYNTHETIC}`;
    let hostsEdited = false;
    let host = "";
    try {
      try {
        fs.appendFileSync("/etc/hosts", `\n${entry}\n`);
        hostsEdited = true;
      } catch {
        hostsEdited = false;
      }
      const candidate = hostsEdited ? SYNTHETIC : os.hostname();
      if (candidate.includes(".")) {
        const addrs = await Bun.dns.lookup(candidate);
        if (addrs.length > 0) host = candidate;
      }
    } catch {
      host = "";
    }
    if (!host) {
      if (hostsEdited) {
        try {
          const contents = fs.readFileSync("/etc/hosts", "utf8");
          fs.writeFileSync(
            "/etc/hosts",
            contents.split("\n").filter((l) => l.trim() !== entry).join("\n"),
          );
          hostsEdited = false;
        } catch {
          // best-effort; leave the entry
        }
      }
      console.log(
        "[gateway] skipping hostname regression test: no writable /etc/hosts and no dotted hostname",
      );
      return;
    }
    try {
      const gwHost = await resolveBindHost(host);
      const store4 = new MemoryNodeStore();
      const gw4 = await createGateway({
        store: store4,
        port: 30970,
        hostname: host,
        statusOf: checkNode,
        notifierIntervalMs: 0,
        portRange: { first: 30940, last: 30960 },
      });
      try {
        // Bound to the resolved IP, not the bare name.
        expect(gw4.server.hostname).toBe(gwHost);
        const res = await fetch(`http://${gwHost}:30970/api/health`);
        expect(res.status).toBe(200);
      } finally {
        gw4.stop();
      }
    } finally {
      if (hostsEdited) {
        // Remove the synthetic entry so repeated runs and concurrent suites
        // do not stack duplicates in /etc/hosts.
        try {
          const contents = fs.readFileSync("/etc/hosts", "utf8");
          fs.writeFileSync(
            "/etc/hosts",
            contents.split("\n").filter((l) => l.trim() !== entry).join("\n"),
          );
        } catch {
          // best-effort; do not fail the test over cleanup
        }
      }
    }
  });

  test("non-local bind target falls back to 0.0.0.0 and serves (no crash loop)", async () => {
    // Regression for the container crash-loop: MULTI_OMP_HOST set to the
    // machine FQDN resolves to the host LAN IP (e.g. 172.16.10.102), which
    // is not an address of the container's netns — the kernel rejects the
    // bind and the gateway died on every start. selectBindHost must fall
    // back to 0.0.0.0 (Docker's port publishing reaches it anyway).
    //
    // 203.0.113.0/24 (RFC 5737 TEST-NET-3) is guaranteed non-local on any
    // machine; a synthetic /etc/hosts name exercises the hostname path.
    const SYNTHETIC = "multi-omp-nolocal.invalid";
    const entry = `203.0.113.7\t${SYNTHETIC}`;
    let hostsEdited = false;
    let rawHost = "";
    try {
      try {
        fs.appendFileSync("/etc/hosts", `\n${entry}\n`);
        hostsEdited = true;
        rawHost = SYNTHETIC;
      } catch {
        // /etc/hosts not writable: still exercise the path with the IP
        // literal directly.
        rawHost = "203.0.113.7";
      }
      const store5 = new MemoryNodeStore();
      const gw5 = await createGateway({
        store: store5,
        port: 30971,
        hostname: rawHost,
        statusOf: checkNode,
        notifierIntervalMs: 0,
        portRange: { first: 30940, last: 30960 },
      });
      try {
        // Non-local IPv4 → canonical container bind, not the raw target.
        expect(gw5.server.hostname).toBe("0.0.0.0");
        const res = await fetch("http://127.0.0.1:30971/api/health");
        expect(res.status).toBe(200);
      } finally {
        gw5.stop();
      }
    } finally {
      if (hostsEdited) {
        try {
          const contents = fs.readFileSync("/etc/hosts", "utf8");
          fs.writeFileSync(
            "/etc/hosts",
            contents.split("\n").filter((l) => l.trim() !== entry).join("\n"),
          );
        } catch {
          // best-effort; do not fail the test over cleanup
        }
      }
    }
  });

  test("client-facing URLs use the request Host header, not the bind host", async () => {
    // The Docker case: the gateway binds 0.0.0.0 but the browser reaches it
    // via the machine's hostname. Generated URLs (dashboard Open links,
    // switcher-bar GW origin) must use the reachable host from the request,
    // or the bar's /api/nodes fetch goes to http://0.0.0.0:PORT and dies.
    const store6 = new MemoryNodeStore();
    const gw6 = await createGateway({
      store: store6,
      port: 30972,
      hostname: "127.0.0.1",
      statusOf: checkNode,
      notifierIntervalMs: 0,
      portRange: { first: 30940, last: 30960 },
    });
    try {
      await gw6.addNode({ name: "HostProbe", url: mock2.url, password: "mock-pass", port: 30965 });
      const dash = await gw6.handle(
        new Request("http://gw/", { headers: { host: "maat.menfis" } }),
      );
      const html = await dash.text();
      // The Open link uses the public host, never the bind address.
      expect(html).toContain(`http://maat.menfis:30965/`);
      expect(html).not.toContain("http://127.0.0.1:30965/");

      // The bar injected into the node page uses the same public host.
      const barRes = await fetch("http://127.0.0.1:30965/", {
        headers: { host: "maat.menfis:30965" },
        redirect: "manual",
      });
      const barHtml = await barRes.text();
      expect(barHtml).toContain('var GW = "http://maat.menfis:30972";');
    } finally {
      gw6.stop();
    }
  });
});
