# multi-omp

One gateway for all your [omp-web](https://github.com/omp-lang/omp-web) nodes.

omp-web instances live on heterogeneous machines (Windows, Debian, Raspberry Pi)
behind firewalls and VPNs, each bound to `127.0.0.1` with Basic auth. multi-omp
sits on one machine you can reach, registers the nodes, and serves each one at
the root of its own local port — byte-for-byte, so the SPA works exactly as
upstream intended, today and in future omp-web releases.

```
browser ──► http://<gw-host>:30140/          dashboard + control plane
          http://<gw-host>:30201/            node "local"  ──► 127.0.0.1:30141 (omp-web)
          http://<gw-host>:30202/            node "rasp"   ──► 192.168.1.20:30141
```

## Architecture

- **`src/gateway.ts`** — control-plane HTTP server (`Bun.serve`) on the gateway
  port (default `30140`): renders the dashboard, exposes the node-management
  REST API, and owns one proxy listener per node.
- **`src/proxy.ts`** — transparent reverse proxy. Forwards path+query+method+
  body as-is to the node origin; rewrites only the `Host` header (omp-web
  validates it) and injects Basic auth from the local store. Response streams
  back unchanged (SSE included). **No HTML is inspected or rewritten.**
- **`src/store.ts`** — node registry. `FileNodeStore` persists to
  `nodes.json` (`0600`) under `MULTI_OMP_HOME`; `MemoryNodeStore` for tests.
- **`src/ports.ts`** — per-node port allocation from `30200–30299`. Ports are
  stable (stored on the node record) and verified by a real bind before use,
  so a port held by the OS is skipped, never crashed on.
- **`src/upstream.ts`** — health checks: `200` = ok, `401` = ok+locked,
  `403` = host not allowed, anything else / timeout = down.
- **`src/dashboard.ts`** — single template string + vanilla JS. No framework.

### Why per-node ports (and not a single-origin proxy)

The obvious alternative is one gateway origin with path prefixes
(`/n/<id>/...`) and rewritten HTML `<base>` tags. That breaks on Next.js:
omp-web is a prebuilt Next.js app whose client-side hydration re-emits
asset `<link>`/`<script>` tags from RSC flight data, discarding any server-side
prefixing — assets 404 and the SPA dies. Fixing that would require rewriting
streamed JS chunks, which is fragile and breaks on every omp-web release.
Serving each node at the **root of its own port** means every absolute path
(`/_next/...`, `/api/...`, `/recover`) resolves natively: zero rewriting,
zero coupling to omp-web's internals.

## Quick start

```sh
bun install
bun src/index.ts                       # dashboard on http://127.0.0.1:30140
```

Then open the dashboard and add nodes (name, url, optional credentials), or
use the API:

```sh
curl -X POST http://127.0.0.1:30140/api/nodes \
  -H 'content-type: application/json' \
  -d '{"name":"Raspberry","url":"http://192.168.1.20:30141","username":"omp","password":"..."}'
```

Each node gets a local port from `30200–30299` (shown in the dashboard's
"Local" column) and stays on that port across restarts.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `MULTI_OMP_PORT` (or `PORT`) | `30140` | gateway/control-plane port |
| `MULTI_OMP_HOST` (or `HOSTNAME_BIND`) | `127.0.0.1` | bind address |
| `MULTI_OMP_HOME` | `~/.omp/multi-omp` | data dir; nodes live in `$HOME/nodes.json` |

## API

| Method & path | Result |
|---|---|
| `GET /` | dashboard (HTML) |
| `GET /api/health` | `{ statuses: [{ id, status }] }` for all nodes |
| `GET /api/nodes` | `{ nodes: [...] }` (no passwords; `hasPassword` flag) |
| `GET /api/nodes/:id` | `{ node, status }` |
| `POST /api/nodes` | create `{ name, url, username?, password?, note? }` → `201 { node, status }` |
| `PATCH /api/nodes/:id` | partial update; changing `url` restarts the proxy listener |
| `DELETE /api/nodes/:id` | remove node and stop its listener |

## Security

- Gateway binds `127.0.0.1` by default. To expose it on a LAN, set
  `MULTI_OMP_HOST` and put it behind TLS/auth — anything that can reach it can
  read node statuses and manage the registry.
- Credentials are stored only in `nodes.json` (mode `0600`), never sent to the
  browser (API responses carry `hasPassword` instead).
- The proxy injects `Authorization` server-side; the browser never sees node
  passwords.
- Node listeners accept connections from any interface the gateway host
  exposes; the dashboard's Open links work from other machines on the LAN.

## Future compatibility

The proxy is deliberately opaque: it forwards bytes and never parses HTML,
JS or routes. A new omp-web version (new chunks, new routes, markup changes)
is served unchanged. The only contract multi-omp relies on:

1. omp-web listens on the configured host:port and answers `GET /` (for
   health checks).
2. Its host-header validation accepts the node's own origin (true by default
   for IP/localhost; see omp-web's `OMP_WEB_ALLOWED_HOSTS`).

## Development

```sh
bun test                # unit + integration; smoke auto-skips if no omp-web at :30141
bun run typecheck       # tsc --noEmit
```
