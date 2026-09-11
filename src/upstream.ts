/**
 * Upstream client: talks to a single omp-web node.
 *
 * Keeps one concern: fetch with the right headers. The gateway's proxy
 * (proxy.ts) streams; the control plane (health, versions) uses `checkNode`.
 */

import type { OmpNode } from "./store";
import { authHeadersFor } from "./store";

export interface NodeStatus {
  ok: boolean;
  /** True when the node is up but its Basic-Auth lock is engaged. */
  locked?: boolean;
  /** Latency in ms of the check. */
  latencyMs?: number;
  /** Why the check failed, when !ok. */
  error?: string;
}

/**
 * Probe a node. omp-web has no explicit "version" endpoint, so we use the
 * lightest surface the middleware serves: GET /. A 401 means the node is up
 * and locked — that is a healthy node, reported with `locked: true`.
 * A 403 means the node rejected our Host header (it is reachable but does
 * not trust us — the user must add our hostname to OMP_WEB_ALLOWED_HOSTS).
 */
export async function checkNode(node: OmpNode, timeoutMs = 4000): Promise<NodeStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(node.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: authHeadersFor(node),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (res.status === 401) return { ok: true, locked: true, latencyMs };
    if (res.status === 403) {
      return { ok: false, latencyMs, error: "forbidden (node does not allow this Host header)" };
    }
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    return { ok: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

const SKIP_REQUEST_HEADERS: Record<string, true> = {
  host: true,
  connection: true,
  "keep-alive": true,
  "transfer-encoding": true,
  upgrade: true,
  te: true,
  trailer: true,
  "proxy-authorization": true,
  "proxy-authenticate": true,
};

/**
 * Build the outgoing headers for a proxied request.
 *
 * - Host: rewritten to the node's host. omp-web validates the Host header
 *   against its bind hostname / OMP_WEB_ALLOWED_HOSTS; IP-literal and
 *   localhost hosts are always accepted, which covers LAN/VPN setups.
 * - Authorization: injected from the local store — the browser never holds
 *   the node credentials.
 * - Hop-by-hop headers: dropped.
 */
export function buildUpstreamHeaders(req: Request, node: OmpNode): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) {
    if (SKIP_REQUEST_HEADERS[k.toLowerCase()]) continue;
    headers[k] = v;
  }
  const nodeUrl = new URL(node.url);
  headers["host"] = nodeUrl.host;
  const auth = authHeadersFor(node);
  if (auth) headers["authorization"] = auth["Authorization"];
  return headers;
}
