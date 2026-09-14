/**
 * Mock upstream: a tiny Bun server that mimics the parts of omp-web the
 * gateway depends on:
 *   - Host-header validation (403 for untrusted hosts, 200 for IP/localhost)
 *   - optional Basic auth (401 without credentials when locked)
 *   - HTML page at / with absolute asset refs + SSE endpoint
 *   - static asset under /_next/static/
 *   - JSON api endpoint
 */
type BunServer = Bun.Server<unknown>;

export interface MockUpstream {
  url: string;
  port: number;
  server: BunServer;
  /** flip the lock on/off without restarting */
  setLocked(locked: boolean): void;
  /**
   * Configure what the node reports at /api/sessions and
   * /api/sessions/:id/state (the notifier/bar input). `running: true`
   * advertises the id in runningSessionIds; `promptRunning: false` +
   * `pending > 0` classifies as waiting.
   */
  setSessions(sessions: Record<string, { name?: string; running?: boolean; promptRunning?: boolean; pending?: number }>): void;
  requests: { host: string; path: string; auth: string | null; origin: string | null }[];
}

export interface MockOptions {
  port?: number;
  locked?: boolean;
  /** Override host validation: return true to 403. Default: reject non-IP, non-localhost hosts. */
  rejectHost?: (host: string) => boolean;
}

const defaultReject = (host: string): boolean => {
  const h = host.replace(/:\d+$/, "");
  const isIp = /^[\d.]+$/.test(h) || /^\[?[0-9a-f:]+\]?$/i.test(h) && h.includes(":") && !h.includes("..");
  return !isIp && !h.startsWith("localhost") && !h.endsWith(".localhost");
};

export function startMockUpstream(opts: MockOptions = {}): Promise<MockUpstream> {
  return new Promise((resolve, reject) => {
    const basePort = opts.port ?? 39100 + Math.floor(Math.random() * 500);
    const rejectHost = opts.rejectHost ?? defaultReject;
    let locked = opts.locked ?? false;
    const requests: MockUpstream["requests"] = [];
    let sessions: Record<string, { name?: string; running?: boolean; promptRunning?: boolean; pending?: number }> = {};
    const password = "mock-pass";

    const attempt = (port: number, triesLeft: number) => {
      let server: BunServer;
      try {
        server = Bun.serve({
          port,
          hostname: "127.0.0.1",
          fetch(req) {
            const url = new URL(req.url);
            const host = req.headers.get("host") ?? "";
            const auth = req.headers.get("authorization") ?? null;
            requests.push({ host, path: url.pathname + url.search, auth, origin: req.headers.get("origin") ?? null });

            if (rejectHost(host)) return new Response("forbidden", { status: 403 });

            if (locked) {
              const expected = `Basic ${Buffer.from(`omp:${password}`).toString("base64")}`;
              if (auth !== expected) {
                return new Response("unauthorized", {
                  status: 401,
                  headers: { "www-authenticate": 'Basic realm="omp-web"' },
                });
              }
            }

            if (url.pathname === "/") {
              const html = [
                `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>`,
                `<link rel="stylesheet" href="/_next/static/css/app.css">`,
                `<script src="/_next/static/chunks/main.js"></script>`,
                `<link rel="icon" href="/favicon.ico">`,
                `<link rel="manifest" href="/manifest.webmanifest">`,
                `<title>mock omp-web</title></head>`,
                `<body><div id="root">MOCK APP</div>`,
                `<script>fetch('/api/sessions');new EventSource('/api/agent/1/events');</script>`,
                `</body></html>`,
              ].join("");
              return new Response(html, {
                headers: { "content-type": "text/html; charset=utf-8", "x-upstream": "mock" },
              });
            }

            if (url.pathname === "/_next/static/css/app.css") {
              return new Response("body{color:red}", { headers: { "content-type": "text/css" } });
            }
            if (url.pathname === "/_next/static/chunks/main.js") {
              return new Response("console.log('main')", { headers: { "content-type": "text/javascript" } });
            }
            if (url.pathname === "/favicon.ico") {
              return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/x-icon" } });
            }
            if (url.pathname === "/manifest.webmanifest") {
              return new Response(`{"name":"mock"}`, { headers: { "content-type": "application/manifest+json" } });
            }
            if (url.pathname === "/api/sessions") {
              const ids = Object.keys(sessions);
              return Response.json({
                sessions: ids.map((id) => ({ id, name: sessions[id].name })),
                runningSessionIds: ids.filter((id) => sessions[id].running !== false),
              });
            }
            const sm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/state$/);
            if (sm) {
              const s = sessions[decodeURIComponent(sm[1])];
              if (!s) return new Response("not found", { status: 404 });
              return Response.json({
                running: s.running !== false,
                state: {
                  isPromptRunning: s.promptRunning !== false,
                  pendingMessageCount: s.pending ?? 0,
                },
              });
            }
            if (url.pathname === "/api/agent/1/events") {
              const stream = new ReadableStream({
                start(controller) {
                  const enc = new TextEncoder();
                  controller.enqueue(enc.encode("event: connected\ndata: {\"type\":\"connected\"}\n\n"));
                  setTimeout(() => {
                    controller.enqueue(enc.encode("event: msg\ndata: {\"type\":\"msg\",\"text\":\"hello\"}\n\n"));
                    controller.close();
                  }, 5);
                },
              });
              return new Response(stream, {
                headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
              });
            }
            return new Response("not found", { status: 404 });
          },
        });
      } catch (e) {
        // Random port collision with a parallel test worker: try the next port.
        if (triesLeft > 0) return attempt(port + 1, triesLeft - 1);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const startedAt = Date.now();
      (async () => {
        while (Date.now() - startedAt < 3000) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(200) });
            if (res.status === 200) break;
          } catch {
            // not ready yet
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          server,
          setLocked: (v) => (locked = v),
          setSessions: (v) => (sessions = v),
          requests,
        });
      })();
    };

    attempt(basePort, 20);
  });
}
