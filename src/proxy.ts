/**
 * Transparent reverse proxy for a single omp-web node.
 *
 * Each node is served at the ROOT of its own dedicated port (allocated by
 * the gateway), so every absolute path the app uses (/_next/..., /api/...,
 * /recover, /manifest.webmanifest) works natively — the upstream is proxied
 * path-for-path and byte-for-byte, with exactly two modifications:
 *
 *   - Host header rewritten to the node's host (omp-web validates it),
 *   - Basic Authorization injected from the local store (the browser never
 *     holds node credentials).
 *
 * No HTML is inspected or rewritten, so a future omp-web release that
 * changes markup, chunks or routes cannot break the proxy.
 */

import type { OmpNode } from "./store";
import { buildUpstreamHeaders } from "./upstream";

const SKIP_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "transfer-encoding": true,
  "content-encoding": true,
  "content-length": true,
  "set-cookie": true,
};

/** Response headers minus hop-by-hop and framing headers. */
export function filterResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    if (SKIP_RESPONSE_HEADERS[k.toLowerCase()]) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Proxy one request to the node, streaming the response back unchanged
 * (SSE events included). The incoming request's path+query are used as-is
 * against the node origin, because the node lives at the root of its port.
 */
export async function proxyRequest(req: Request, node: OmpNode): Promise<Response> {
  const u = new URL(req.url);
  const target = `${node.url}${u.pathname}${u.search}`;
  const res = await fetch(target, {
    method: req.method,
    headers: buildUpstreamHeaders(req, node),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.body as ReadableStream),
    redirect: "manual",
  });
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: filterResponseHeaders(res),
  });
}
