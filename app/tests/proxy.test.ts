import { describe, expect, test } from "bun:test";
import { filterResponseHeaders, proxyRequest } from "../src/proxy";
import type { OmpNode } from "../src/store";

const node: OmpNode = {
  id: "raspberry",
  name: "Raspberry",
  url: "http://192.168.1.20:30141",
  username: "omp",
  password: "s3cret",
};
function mockFetch(impl: (input: Request | string, init?: RequestInit) => Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (impl as typeof fetch);
  return () => {
    globalThis.fetch = orig;
  };
}

describe("proxyRequest", () => {
  test("forwards path, query, method and body to the node origin", async () => {
    const seen: { url?: string; method?: string; host?: string; auth?: string; body?: string } = {};
    const restore = mockFetch(async (input, init) => {
      const u = String(input);
      const h = new Headers(init?.headers);
      seen.url = u;
      seen.method = init?.method;
      seen.host = h.get("host") ?? undefined;
      seen.auth = h.get("authorization") ?? undefined;
      seen.body =
        init?.body === undefined
          ? undefined
          : init.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init.body);
      return new Response("ok-body", { status: 200, headers: { "content-type": "text/plain" } });
    });
    try {
      const res = await proxyRequest(
        new Request("http://gw:30200/api/agent/42/events?live=1", {
          method: "POST",
          body: "payload",
          headers: { "content-type": "application/json" },
        }),
        node,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok-body");
      expect(seen.url).toBe("http://192.168.1.20:30141/api/agent/42/events?live=1");
      expect(seen.method).toBe("POST");
      expect(seen.host).toBe("192.168.1.20:30141");
      expect(seen.auth).toBe(`Basic ${btoa("omp:s3cret")}`);
      expect(seen.body).toBe("payload");
    } finally {
      restore();
    }
  });

  test("does not send a body for GET", async () => {
    let body: unknown = "sentinel";
    const restore = mockFetch(async (_input, init) => {
      body = init?.body;
      return new Response("", { status: 200 });
    });
    try {
      await proxyRequest(new Request("http://gw:30200/", { method: "GET" }), node);
      expect(body).toBeUndefined();
    } finally {
      restore();
    }
  });
  test("rewrites the browser Origin to the node origin", async () => {
    const seen: { origin?: string | null } = {};
    const restore = mockFetch(async (_input, init) => {
      const h = new Headers(init?.headers);
      seen.origin = h.get("origin");
      return new Response("ok", { status: 200 });
    });
    try {
      await proxyRequest(
        new Request("http://127.0.0.1:30200/api/agent/42", {
          method: "POST",
          body: JSON.stringify({ type: "prompt", message: "hi" }),
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:30200" },
        }),
        node,
      );
      expect(seen.origin).toBe("http://192.168.1.20:30141");
    } finally {
      restore();
    }
  });

  test("does not inject an Origin when the request has none", async () => {
    const seen: { origin?: string | null } = {};
    const restore = mockFetch(async (_input, init) => {
      const h = new Headers(init?.headers);
      seen.origin = h.get("origin");
      return new Response("ok", { status: 200 });
    });
    try {
      await proxyRequest(new Request("http://127.0.0.1:30200/api/sessions"), node);
      expect(seen.origin).toBeNull();
    } finally {
      restore();
    }
  });

  test("passes through status and streams the body", async () => {
    const restore = mockFetch(async () =>
      new Response("streamed", { status: 503, headers: { "x-upstream": "yes" } }),
    );
    try {
      const res = await proxyRequest(new Request("http://gw:30200/x"), node);
      expect(res.status).toBe(503);
      expect(res.headers.get("x-upstream")).toBe("yes");
      expect(await res.text()).toBe("streamed");
    } finally {
      restore();
    }
  });

  test("forwards set-cookie headers", async () => {
    const restore = mockFetch(async () =>
      new Response("ok", { headers: { "set-cookie": "sid=abc; Path=/; HttpOnly" } }),
    );
    try {
      const res = await proxyRequest(new Request("http://gw/session"), node);
      expect(res.headers.get("set-cookie")).toBe("sid=abc; Path=/; HttpOnly");
    } finally {
      restore();
    }
  });
});

describe("filterResponseHeaders", () => {
  test("drops hop-by-hop and framing headers", () => {
    const res = new Response("x", {
      headers: {
        "content-type": "text/html",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "content-encoding": "gzip",
        "content-length": "1",
        etag: "abc",
      },
    });
    const out = filterResponseHeaders(res);
    expect(out["content-type"]).toBe("text/html");
    expect(out["etag"]).toBe("abc");
    expect("connection" in out).toBe(false);
    expect("keep-alive" in out).toBe(false);
    expect("transfer-encoding" in out).toBe(false);
    expect("content-encoding" in out).toBe(false);
    expect("content-length" in out).toBe(false);
  });
});
