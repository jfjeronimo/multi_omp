/**
 * The gateway: a dashboard + control plane on one port, plus one transparent
 * reverse-proxy listener per node, each on its own dedicated port.
 *
 *   :30140  dashboard + control API (GET /, /api/nodes, /api/health)
 *   :302xx  one listener per node; every request is proxied to that node
 *           origin at the same path, with Host rewritten and Basic Auth
 *           injected. The node's app is served unmodified at the root of
 *           its port, so omp-web's own routing/assets/SSE work natively.
 *
 * Node ports are persisted on the node record, so they are stable across
 * gateway restarts.
 */
import type { NodeStore, OmpNode } from "./store";
import { parseNodeId, slugify } from "./store";
import { checkNode, type NodeStatus } from "./upstream";
import { proxyRequest, filterResponseHeaders } from "./proxy";
import { diagnosePortHeld, probePortFree, rangePorts, selectBindHost } from "./ports";
import { renderDashboard, renderNodeBar, type DashboardNode } from "./dashboard";
import {
  createSessionNotifier,
  nodeSnapshot,
  sendTelegram,
  type NotifierSnapshot,
  type SessionNotifier,
} from "./telegram";

/**
 * CORS headers for the control-plane API. The node-switcher bar lives on a
 * node port (e.g. :30201) and fetches this API cross-origin; the API is
 * credential-free from the browser's point of view (node credentials are
 * injected server-side by the gateway), so a blanket `*` origin is safe.
 */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

/** Bun's HTTP server (WebSocketData = unknown, the default). */
export type Server = Bun.Server<unknown>;

/** The doubled Oh-My-Pi mark served at /favicon.ico (SVG, no binary .ico). */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 142"><g transform="translate(46,-26)" opacity=".45"><rect x="10" y="8" width="100" height="12" rx="2" fill="#c9c9c9"/><rect x="25" y="20" width="12" height="62" rx="2" fill="#c9c9c9"/><rect x="75" y="20" width="12" height="45" rx="2" fill="#c9c9c9"/><rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316"/><rect x="76" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/><rect x="82" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/><circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8"/><circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8"/></g><g><rect x="10" y="8" width="100" height="12" rx="2" fill="#fafafa"/><rect x="25" y="20" width="12" height="62" rx="2" fill="#fafafa"/><rect x="75" y="20" width="12" height="45" rx="2" fill="#fafafa"/><rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316"/><rect x="76" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/><rect x="82" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/><circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8"/><circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8"/></g></svg>`;

export interface NodeListener {
  id: string;
  server: Server;
}

export interface Gateway {
  /** The control-plane server (port/hostname/stop live here). */
  server: Server;
  /** Per-node proxy listeners currently running. */
  nodes(): NodeListener[];
  /** Control-plane handler for one incoming request (used by tests). */
  handle(req: Request): Promise<Response>;
  /** Register a node: allocate/reuse a port, persist it, start its proxy. */
  addNode(input: Omit<OmpNode, "id"> & { id?: string }): Promise<{ node: OmpNode; status: NodeStatus }>;
  /** Update a node's url/credentials; rebind its listener only when the port changed. */
  updateNode(id: string, patch: Partial<OmpNode>): Promise<{ node: OmpNode; status: NodeStatus }>;
  /** Stop a node's listener and remove it from the store. */
  removeNode(id: string): boolean;
  /** Stop every listener (control plane + node proxies). */
  stop(): void;
}

export interface GatewayOptions {
  store: NodeStore;
  port?: number;
  hostname?: string;
  version?: string;
  /** Injected for tests: node -> status provider. */
  statusOf?: (node: OmpNode) => Promise<NodeStatus>;
  /** Local port range for node listeners (defaults 30200-30299). */
  portRange?: { first: number; last: number };
  /** Telegram notifier poll interval in ms; 0 disables the notifier. */
  notifierIntervalMs?: number;
  /** Injected for tests: replace the notifier factory. */
  createNotifier?: (
    opts: Parameters<typeof createSessionNotifier>[0],
  ) => SessionNotifier;
}

/**
 * Client-facing host for the URLs the browser uses to reach the gateway:
 * the `Host` header of the request (hostname part, no port) — the name the
 * browser already proved it can resolve and reach. The bind hostname
 * (`0.0.0.0` in Docker) is NOT reachable by a client, so it must never
 * appear in a generated URL; it is only the fallback for requests without
 * a `Host` header (curl, tests).
 */
function publicHostOf(req: Request, bindHost: string): string {
  const h = req.headers.get("host");
  if (h) {
    const host = h.split(":")[0] ?? h; // "host:port" → "host" (IPv6 literal: first ":" split is still the hostname here — Bun sends "ipv6:port" unbracketed, and the browser never does)
    if (host) return host;
  }
  return bindHost;
}
export async function createGateway(opts: GatewayOptions): Promise<Gateway> {
  const port = opts.port ?? 30140;
  const rawHost = opts.hostname ?? "127.0.0.1";
  // A hostname (e.g. the machine FQDN from HOSTNAME_BIND) must never reach
  // Bun.serve: the runtime resolves it to the machine's LAN IP, which inside
  // a container is not an address of the container's netns — the kernel
  // refuses the bind (EADDRNOTAVAIL; some Bun versions report it as
  // EADDRINUSE with errno 0) and no socket is ever created in /proc.
  // selectBindHost resolves to an IP literal and falls back to 0.0.0.0 when
  // that IP is not local to this environment.
  const hostname = await selectBindHost(rawHost);
  const version = opts.version ?? "0.1.0";
  const statusOf = opts.statusOf ?? checkNode;
  const portRange = opts.portRange ?? { first: 30200, last: 30299 };
  /**
   * Bun.serve throws synchronously when the port is taken. On container
   * restarts the previous process is often still releasing the socket
   * (TIME_WAIT / not yet SIGKILLed), so a single attempt fails with
   * EADDRINUSE. Retry on EADDRINUSE with backoff until the port frees up or
   * `maxMs` elapses, then rethrow.
   */
  function bindWithRetry(
    make: (port: number) => Server,
    port: number,
    maxMs = 15000,
    baseDelayMs = 150,
  ): Server {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return make(port);
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: string }).code : undefined;
        const isAddrInUse =
          e instanceof Error &&
          (code === "EADDRINUSE" || e.message.includes("EADDRINUSE") || e.message.includes("in use"));
        if (!isAddrInUse) throw e;
        const elapsed = Date.now() - started;
        if (elapsed >= maxMs) throw e;
        const delay = Math.min(baseDelayMs * attempt, 2000);
        console.warn(
          `multi-omp: port ${port} busy (attempt ${attempt}); retrying in ${delay}ms`,
        );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }


  /** id -> running node listener. */
  const listeners = new Map<string, NodeListener>();

  function usedPorts(): Set<number> {
    const used = new Set<number>(opts.store.list().map((n) => n.port).filter((p): p is number => typeof p === "number"));
    for (const l of listeners.values()) if (l.server.port) used.add(l.server.port);
    return used;
  }

  /**
   * Choose a port for `node`: honor `node.port` when set, otherwise the first
   * range port that is neither allocated by multi-omp nor held by the OS
   * (verified by a real bind). The control-plane port is always excluded, so
   * a node can never shadow the dashboard. Returns null when nothing is
   * available.
   */
  function pickPort(node: OmpNode): number | null {
    const chosen = node.port !== undefined && node.port !== port ? node.port : undefined;
    if (chosen !== undefined) return chosen;
    for (const candidate of rangePorts(portRange.first, portRange.last)) {
      if (candidate === port) continue;
      if (usedPorts().has(candidate)) continue;
      if (!probePortFree(candidate, hostname)) continue;
      return candidate;
    }
    return null;
  }

  function startNodeServer(node: OmpNode): NodeListener {
    const nodePort = pickPort(node);
    if (nodePort === null) throw new Error(`No free local port in range ${portRange.first}-${portRange.last}`);
    // The handler re-reads the node from the store on every request, so a
    // url/credential PATCH takes effect immediately without a restart.
    const server = bindWithRetry((p) => Bun.serve({
      port: p,
      hostname,
      fetch: async (req) => {
        const current = opts.store.get(node.id);
        if (!current) {
          return new Response(JSON.stringify({ error: `node "${node.id}" no longer exists` }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        try {
          const res = await proxyRequest(req, current);
          // Inject the node-switcher bar into the root HTML document. Only the
          // browser-facing HTML page (not API/SSE/asset responses) is touched.
          const ctype = res.headers.get("content-type") ?? "";
          if (
            req.method === "GET" &&
            res.status === 200 &&
            ctype.includes("text/html") &&
            !req.url.includes("/api/") &&
            !req.url.startsWith("data:")
          ) {
            const body = await res.text();
            const gwOrigin = `http://${publicHostOf(req, hostname)}:${port}`;
            const bar = renderNodeBar(gwOrigin, current.id);
            const html = body.includes("</body>")
              ? body.replace("</body>", `${bar}\n</body>`)
              : body + bar;
            return new Response(html, {
              status: res.status,
              statusText: res.statusText,
              headers: filterResponseHeaders(res),
            });
          }
          return res;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(JSON.stringify({ error: `proxy to ${current.id} failed: ${msg}` }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
      },
    }), nodePort);
    // If the port was fresh (not saved), persist it so the node record — and
    // therefore GET /api/nodes/:id — reflects the actual proxy port.
    if (node.port !== nodePort) opts.store.update(node.id, { port: nodePort });
    const listener: NodeListener = { id: node.id, server };
    listeners.set(node.id, listener);
    return listener;
  }

  function stopNodeServer(id: string): void {
    const l = listeners.get(id);
    if (l) {
      l.server.stop(true);
      listeners.delete(id);
    }
  }

  /**
   * Start (or move) the listener for `node`. Only a port change requires a
   * restart: url/credential changes are picked up per-request by the fresh
   * store read inside the fetch handler.
   */
  function ensureNodeServer(node: OmpNode): NodeListener {
    const existing = listeners.get(node.id);
    if (existing && existing.server.port === node.port) return existing;
    // A node whose saved port is the control-plane port can never bind
    // (the dashboard owns it): drop the saved port and allocate a fresh one.
    if (node.port === port) {
      console.warn(
        `multi-omp: node ${node.id} saved port ${port} collides with the control plane; re-assigning`,
      );
      opts.store.update(node.id, { port: undefined });
      node = { ...node, port: undefined };
    }
    stopNodeServer(node.id);
    return startNodeServer(node);
  }

  async function withStatus(node: OmpNode): Promise<{ node: OmpNode; status: NodeStatus }> {
    return { node, status: await statusOf(node) };
  }

  async function dashboard(req: Request): Promise<Response> {
    const nodes: DashboardNode[] = await Promise.all(
      opts.store.list().map(async (n) => ({
        id: n.id,
        name: n.name,
        url: n.url,
        port: n.port,
        hasPassword: Boolean(n.password),
        note: n.note,
        hasTelegram: Boolean(n.telegramToken && n.telegramChatId),
        status: await statusOf(n),
      })),
    );
    return new Response(renderDashboard(nodes, publicHostOf(req, hostname), port, version), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  /**
   * Allocate a port, persist it on the node record, and bind the listener —
   * as one transaction: if the bind fails, the port is not left persisted
   * on a dead node record.
   */
  async function addNode(
    input: Omit<OmpNode, "id"> & { id?: string },
  ): Promise<{ node: OmpNode; status: NodeStatus }> {
    const nodePort = pickPort({ ...input, id: input.id ?? "" } as OmpNode);
    if (nodePort === null) throw new Error(`No free local port in range ${portRange.first}-${portRange.last}`);
    const id = input.id ?? slugify(input.name || input.url, new Set(opts.store.list().map((n) => n.id)));
    const node = opts.store.add({ ...input, id, port: nodePort } as OmpNode);
    try {
      ensureNodeServer(node);
    } catch (e) {
      opts.store.remove(id);
      throw e;
    }
    return withStatus(node);
  }

  async function updateNode(
    id: string,
    patch: Partial<OmpNode>,
  ): Promise<{ node: OmpNode; status: NodeStatus }> {
    const updated = opts.store.update(id, patch);
    ensureNodeServer(updated);
    return withStatus(updated);
  }

  function removeNode(id: string): boolean {
    stopNodeServer(id);
    return opts.store.remove(id);
  }

  async function controlPlane(req: Request, url: URL): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const res = await controlPlaneInner(req, url);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }

  async function controlPlaneInner(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/health" && method === "GET") {
      const statuses = await Promise.all(
        opts.store.list().map(async (n) => ({ id: n.id, status: await statusOf(n) })),
      );
      return new Response(JSON.stringify({ statuses }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/api/nodes" && method === "GET") {
      return new Response(
        JSON.stringify({ nodes: opts.store.list().map(publicNode) }),
        { headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/api/nodes" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await req.json();
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const rawUrl = typeof body.url === "string" ? body.url : "";
      if (!name || !rawUrl) {
        return new Response(JSON.stringify({ error: "name and url are required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const { node, status } = await addNode({
          id: typeof body.id === "string" && body.id ? body.id : undefined,
          name,
          url: rawUrl,
          username: typeof body.username === "string" && body.username ? body.username : "omp",
          password: typeof body.password === "string" && body.password ? body.password : undefined,
          note: typeof body.note === "string" && body.note ? body.note : undefined,
          telegramToken: typeof body.telegramToken === "string" && body.telegramToken ? body.telegramToken : undefined,
          telegramChatId: typeof body.telegramChatId === "string" && body.telegramChatId ? body.telegramChatId : undefined,
        });
        return new Response(JSON.stringify({ node: publicNode(node), status }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }
    const mm = path.match(/^\/api\/nodes\/([^/]+)\/metrics$/);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      const node = opts.store.get(id);
      if (!node) {
        return new Response(JSON.stringify({ error: `Unknown node "${id}"` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "content-type": "application/json" },
        });
      }
      const status = await statusOf(node);
      const snap = await nodeSnapshot(node);
      const sessions = Object.values(snap.sessions);
      return new Response(
        JSON.stringify({
          status,
          running: sessions.filter((s) => s.state === "running").length,
          waiting: sessions.filter((s) => s.state === "waiting").length,
          idle: sessions.filter((s) => s.state === "idle").length,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    const m = path.match(/^\/api\/nodes\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (parseNodeId(id) === null) {
        return new Response(JSON.stringify({ error: `Invalid node id "${id}"` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const node = opts.store.get(id);
      if (!node) {
        return new Response(JSON.stringify({ error: `Unknown node "${id}"` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET") {
        const status = await statusOf(node);
        return new Response(JSON.stringify({ node: publicNode(node), status }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" || method === "PUT") {
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = await req.json();
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          body = parsed as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const patch: Partial<OmpNode> = {};
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
        if (typeof body.url === "string" && body.url) patch.url = body.url;
        if (typeof body.note === "string") patch.note = body.note;
        if (body.password === null) patch.password = undefined;
        else if (typeof body.password === "string") patch.password = body.password;
        if (body.username === null) patch.username = undefined;
        else if (typeof body.username === "string") patch.username = body.username;
        if (body.telegramToken === null) patch.telegramToken = undefined;
        else if (typeof body.telegramToken === "string") patch.telegramToken = body.telegramToken;
        if (body.telegramChatId === null) patch.telegramChatId = undefined;
        else if (typeof body.telegramChatId === "string") patch.telegramChatId = body.telegramChatId;
        try {
          const { node: updated, status } = await updateNode(id, patch);
          return new Response(JSON.stringify({ node: publicNode(updated), status }), {
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (method === "DELETE") {
        removeNode(id);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") return dashboard(req);
    if (url.pathname.startsWith("/api/")) return controlPlane(req, url);
    if (url.pathname === "/favicon.ico")
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml" },
      });
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  let server: Server;
  try {
    server = bindWithRetry((p) => Bun.serve({ port: p, hostname, fetch: handler }), port);
  } catch (e) {
    // The dashboard must live on its configured port: never re-assign. Print a
    // diagnosis of who is holding the port before the process exits.
    console.error(`multi-omp: control plane could not bind port ${port} after 15s of retries; the port is held by another process`);
    console.error(diagnosePortHeld(port, hostname));
    throw e;
  }

  // Boot listeners for nodes that were already in the store. A node whose
  // saved port is now held by the OS is re-assigned to a free one.
  for (const node of opts.store.list()) {
    try {
      ensureNodeServer(node);
    } catch {
      // Saved port is now held: clear it and try to allocate a fresh one.
      try {
        const reassigned = startNodeServer({ ...node, port: undefined });
        // Persist the new port so the next boot keeps it.
        opts.store.update(node.id, { port: reassigned.server.port });
      } catch (e) {
        // Nothing available in the whole range: restore the saved port so the
        // node keeps its record and the next boot can retry.
        if (node.port !== undefined) opts.store.update(node.id, { port: node.port });
        console.error(`multi-omp: could not start proxy for node ${node.id}: ${(e as Error).message}`);
      }
    }
  }

  // Telegram notifier: polls each node's session states and messages the
  // user when a session starts, finishes a turn, or waits for input.
  const byId = (id: string) => opts.store.get(id);
  const notifierIntervalMs = opts.notifierIntervalMs ?? 10_000;
  const notifier = notifierIntervalMs > 0
    ? (opts.createNotifier ?? createSessionNotifier)({
        intervalMs: notifierIntervalMs,
        collect: async () => {
          const nodes = opts.store.list();
          const snaps = await Promise.all(
            nodes.map(async (n) => {
              const base = await nodeSnapshot(n);
              return {
                ...base,
                telegram:
                  n.telegramToken && n.telegramChatId
                    ? { token: n.telegramToken, chatId: n.telegramChatId }
                    : null,
              };
            }),
          );
          return snaps;
        },
        send: (nodeId, text) => {
          const n = byId(nodeId);
          if (!n?.telegramToken || !n.telegramChatId) {
            return Promise.resolve({ ok: false, error: "telegram not configured" });
          }
          return sendTelegram({ token: n.telegramToken, chatId: n.telegramChatId }, text);
        },
      })
    : undefined;
  notifier?.start();

  return {
    server,
    nodes: () => [...listeners.values()],
    handle: handler,
    addNode,
    updateNode,
    removeNode,
    stop: () => {
      notifier?.stop();
      for (const l of listeners.values()) l.server.stop(true);
      listeners.clear();
      server.stop(true);
    },
  };
}

/**
 * Strip credentials before a node is sent to the browser. The telegram bot
 * token is masked to its leading digits (the bot id) so the dashboard can
 * show "configured for bot 123456" without leaking the secret.
 */
function publicNode(node: OmpNode): Omit<OmpNode, "password" | "telegramToken"> & {
  hasPassword: boolean;
  hasTelegram: boolean;
  telegramBotId?: string;
} {
  const { password, telegramToken, ...rest } = node;
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasTelegram: Boolean(telegramToken && node.telegramChatId),
    telegramBotId: telegramToken ? telegramToken.split(":")[0] : undefined,
  };
}
