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
import { checkNode, type NodeStatus } from "./upstream";
import { proxyRequest } from "./proxy";
import { FIRST_NODE_PORT, LAST_NODE_PORT, probePortFree, rangePorts } from "./ports";
import { renderDashboard, type DashboardNode } from "./dashboard";

/** Bun's HTTP server (WebSocketData = unknown, the default). */
export type Server = Bun.Server<unknown>;

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
  /** Update a node's url/credentials; restart its listener when the origin changed. */
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
}

export function createGateway(opts: GatewayOptions): Gateway {
  const port = opts.port ?? 30140;
  const hostname = opts.hostname ?? "127.0.0.1";
  const version = opts.version ?? "0.1.0";
  const statusOf = opts.statusOf ?? checkNode;
  const portRange = opts.portRange ?? { first: 30200, last: 30299 };

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
   * (verified by a real bind). Returns null when nothing is available.
   */
  function pickPort(node: OmpNode): number | null {
    if (node.port !== undefined) return node.port;
    for (const candidate of rangePorts(portRange.first, portRange.last)) {
      if (usedPorts().has(candidate)) continue;
      if (!probePortFree(candidate, hostname)) continue;
      return candidate;
    }
    return null;
  }

  function startNodeServer(node: OmpNode): NodeListener {
    const nodePort = pickPort(node);
    if (nodePort === null) throw new Error(`No free local port in range ${portRange.first}-${portRange.last}`);
    const server = Bun.serve({
      port: nodePort,
      hostname,
      fetch: async (req) => {
        try {
          return await proxyRequest(req, node);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(JSON.stringify({ error: `proxy to ${node.id} failed: ${msg}` }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
      },
    });
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

  function ensureNodeServer(node: OmpNode): NodeListener {
    const existing = listeners.get(node.id);
    if (existing && existing.server.port === node.port) return existing;
    stopNodeServer(node.id);
    return startNodeServer(node);
  }

  async function withStatus(node: OmpNode): Promise<{ node: OmpNode; status: NodeStatus }> {
    return { node, status: await statusOf(node) };
  }

  async function dashboard(): Promise<Response> {
    const nodes: DashboardNode[] = await Promise.all(
      opts.store.list().map(async (n) => ({
        id: n.id,
        name: n.name,
        url: n.url,
        port: n.port,
        hasPassword: Boolean(n.password),
        note: n.note,
        status: await statusOf(n),
      })),
    );
    return new Response(renderDashboard(nodes, hostname, port, version), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  async function addNode(
    input: Omit<OmpNode, "id"> & { id?: string },
  ): Promise<{ node: OmpNode; status: NodeStatus }> {
    const nodePort = pickPort({ ...input, id: input.id ?? "" } as OmpNode);
    if (nodePort === null) throw new Error(`No free local port in range ${portRange.first}-${portRange.last}`);
    const node = opts.store.add({ ...input, id: input.id ?? "", port: nodePort } as OmpNode);
    ensureNodeServer(node);
    return withStatus(node);
  }

  async function updateNode(
    id: string,
    patch: Partial<OmpNode>,
  ): Promise<{ node: OmpNode; status: NodeStatus }> {
    const updated = opts.store.update(id, patch);
    if (patch.url !== undefined) ensureNodeServer(updated);
    return withStatus(updated);
  }

  function removeNode(id: string): boolean {
    stopNodeServer(id);
    return opts.store.remove(id);
  }

  async function controlPlane(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/health" && method === "GET") {
      const statuses = await Promise.all(
        opts.store.list().map(async (n) => ({ id: n.id, status: await statusOf(n) })),
      );
      return new Response(JSON.stringify({ nodes: statuses }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

    const m = path.match(/^\/api\/nodes\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
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
        if (typeof body.password === "string" && body.password) patch.password = body.password;
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
    if (url.pathname === "/" && req.method === "GET") return dashboard();
    if (url.pathname.startsWith("/api/")) return controlPlane(req, url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  const server = Bun.serve({ port, hostname, fetch: handler });

  // Boot listeners for nodes that were already in the store.
  for (const node of opts.store.list()) {
    try {
      ensureNodeServer(node);
    } catch (e) {
      console.error(`multi-omp: could not start proxy for node ${node.id}: ${(e as Error).message}`);
    }
  }

  return {
    server,
    nodes: () => [...listeners.values()],
    handle: handler,
    addNode,
    updateNode,
    removeNode,
    stop: () => {
      for (const l of listeners.values()) l.server.stop(true);
      listeners.clear();
      server.stop(true);
    },
  };
}

/** Strip credentials before a node is sent to the browser. */
function publicNode(node: OmpNode): Omit<OmpNode, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = node;
  return { ...rest, hasPassword: Boolean(password) };
}
