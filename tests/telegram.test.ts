import { describe, test, expect } from "bun:test";
import {
  createSessionNotifier,
  diffTransitions,
  sendTelegram,
  type NotifierSnapshot,
  type NotifierState,
} from "../src/telegram";

// ---------------------------------------------------------------------------
// diffTransitions (pure)
// ---------------------------------------------------------------------------

const emptyPrev = () => new Map<string, Record<string, NotifierState>>();

function snap(nodeId: string, sessions: NotifierSnapshot["sessions"]): NotifierSnapshot {
  return { id: nodeId, name: nodeId, url: "http://n", telegram: null, sessions };
}

describe("diffTransitions", () => {
  test("no previous poll: running sessions are announced", () => {
    const events = diffTransitions(emptyPrev(), [snap("a", { s1: { state: "running", name: "job" } })]);
    expect(events).toEqual([{ nodeId: "a", session: "s1", state: "running", name: "job" }]);
  });

  test("first poll: idle sessions are NOT announced (no history)", () => {
    const events = diffTransitions(emptyPrev(), [snap("a", { s1: { state: "idle" } })]);
    expect(events).toEqual([]);
  });

  test("running -> idle = finished", () => {
    const prev = new Map([["a", { s1: "running" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "idle" } })]);
    expect(events).toEqual([{ nodeId: "a", session: "s1", state: "idle", name: undefined }]);
  });

  test("running -> waiting = awaiting user", () => {
    const prev = new Map([["a", { s1: "running" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "waiting", name: "x" } })]);
    expect(events).toEqual([{ nodeId: "a", session: "s1", state: "waiting", name: "x" }]);
  });

  test("waiting -> running = resumed (announced)", () => {
    const prev = new Map([["a", { s1: "waiting" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "running" } })]);
    expect(events).toEqual([{ nodeId: "a", session: "s1", state: "running", name: undefined }]);
  });

  test("no change: no events", () => {
    const prev = new Map([["a", { s1: "running" as NotifierState, s2: "idle" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "running" }, s2: { state: "idle" } })]);
    expect(events).toEqual([]);
  });

  test("idle -> running = announced (new turn started)", () => {
    const prev = new Map([["a", { s1: "idle" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "running" } })]);
    expect(events.map((e) => e.state)).toEqual(["running"]);
  });

  test("waiting -> waiting: no event (still waiting)", () => {
    const prev = new Map([["a", { s1: "waiting" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "waiting" } })]);
    expect(events).toEqual([]);
  });

  test("session disappears while running = stopped", () => {
    const prev = new Map([["a", { s1: "running" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", {})]);
    expect(events).toEqual([{ nodeId: "a", session: "s1", state: "stopped", name: undefined }]);
  });

  test("session disappears while idle: no event", () => {
    const prev = new Map([["a", { s1: "idle" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", {})]);
    expect(events).toEqual([]);
  });

  test("multiple events from one node are all emitted", () => {
    const prev = new Map([["a", { s1: "running" as NotifierState, s2: "waiting" as NotifierState }]]);
    const events = diffTransitions(prev, [snap("a", { s1: { state: "idle" }, s2: { state: "running" } })]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.state).sort()).toEqual(["idle", "running"]);
  });
});

// ---------------------------------------------------------------------------
// sendTelegram (against a local mock of the Bot API)
describe("sendTelegram", () => {
  const calls: Array<{ path: string; body: { chat_id?: string; text?: string } }> = [];

  test("returns ok and posts chat_id/text to sendMessage", async () => {
    // sendTelegram hard-codes https://api.telegram.org; test the URL construction
    // indirectly by asserting the function shape via a real fetch stub.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const u = String(input);
      expect(u).toBe("https://api.telegram.org/bot123456:ABC-XYZ/sendMessage");
      calls.push({ path: u, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const res = await sendTelegram({ token: "123456:ABC-XYZ", chatId: "987" }, "hola");
      expect(res.ok).toBe(true);
      expect(calls[0].body).toEqual({ chat_id: "987", text: "hola" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("401 from Bot API is reported with a distinct error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const res = await sendTelegram({ token: "bad", chatId: "1" }, "hola");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("token or chat id wrong");
      expect(res.error).toContain("401");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("network failure returns ok:false without throwing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    try {
      const res = await sendTelegram({ token: "t", chatId: "1" }, "hola", 100);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("ENOTFOUND");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("abort after timeout is reported as timeout", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: URL | string, init?: RequestInit) => {
      await new Promise((_, rej) => {
        const t = setTimeout(() => rej(new Error("slow")), 50);
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    try {
      const res = await sendTelegram({ token: "t", chatId: "1" }, "hola", 20);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("timeout");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// createSessionNotifier: dedupe + per-node grouping
// ---------------------------------------------------------------------------

describe("createSessionNotifier", () => {
  const target = { token: "tok", chatId: "chat" };

  function makeNotifier(
    getSnaps: () => NotifierSnapshot[],
    send: (nodeId: string, text: string) => Promise<{ ok: boolean }>,
  ) {
    const sent: Array<{ nodeId: string; text: string }> = [];
    const notifier = createSessionNotifier({
      collect: async () => getSnaps(),
      send: async (nodeId, text) => {
        sent.push({ nodeId, text });
        return send(nodeId, text);
      },
      intervalMs: 3600_000, // effectively never fires in tests
    });
    return { notifier, sent };
  }

  test("same state twice -> message only on first transition (dedupe)", async () => {
    let current: NotifierSnapshot[] = [
      { id: "a", name: "a", url: "http://a", telegram: target, sessions: { s1: { state: "running", name: "job" } } },
    ];
    const { notifier, sent } = makeNotifier(() => current, async () => ({ ok: true }));
    await notifier.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("arrancó");
    // Second tick: still running -> no new message.
    await notifier.tick();
    expect(sent).toHaveLength(1);
    notifier.stop();
  });

  test("two transitions in one poll are grouped into one message per node", async () => {
    let current: NotifierSnapshot[] = [];
    const { notifier, sent } = makeNotifier(() => current, async () => ({ ok: true }));
    // first tick establishes baseline
    current = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        sessions: { s1: { state: "running", name: "job1" }, s2: { state: "running", name: "job2" } },
      },
    ];
    await notifier.tick();
    // second tick: both finish
    current = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        sessions: { s1: { state: "idle", name: "job1" }, s2: { state: "idle", name: "job2" } },
      },
    ];
    await notifier.tick();
    expect(sent).toHaveLength(2); // 1 (arrancó x2 grouped) + 1 (finalizó x2 grouped)
    expect(sent[1].text).toContain("job1");
    expect(sent[1].text).toContain("job2");
    notifier.stop();
  });

  test("telegramEvents allow-list suppresses disabled kinds (incl. finished)", async () => {
    let current: NotifierSnapshot[] = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        // Only "started" enabled: finished (state idle) must be suppressed.
        telegramEvents: ["started"],
        sessions: { s1: { state: "running", name: "job" } },
      },
    ];
    const { notifier, sent } = makeNotifier(() => current, async () => ({ ok: true }));
    await notifier.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("arrancó");
    // Transition to idle: "finished" is disabled -> no message.
    current = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        telegramEvents: ["started"],
        sessions: { s1: { state: "idle", name: "job" } },
      },
    ];
    await notifier.tick();
    expect(sent).toHaveLength(1);
    notifier.stop();
  });

  test("telegramEvents allowing finished does announce the idle transition", async () => {
    let current: NotifierSnapshot[] = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        telegramEvents: ["finished"],
        sessions: { s1: { state: "running", name: "job" } },
      },
    ];
    const { notifier, sent } = makeNotifier(() => current, async () => ({ ok: true }));
    await notifier.tick();
    // started is disabled -> no message yet.
    expect(sent).toHaveLength(0);
    current = [
      {
        id: "a",
        name: "a",
        url: "http://a",
        telegram: target,
        telegramEvents: ["finished"],
        sessions: { s1: { state: "idle", name: "job" } },
      },
    ];
    await notifier.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("finalizó");
    notifier.stop();
  });

  test("node without telegram config gets no message", async () => {
    const current: NotifierSnapshot[] = [
      { id: "a", name: "a", url: "http://a", telegram: null, sessions: { s1: { state: "running" } } },
    ];
    const { notifier, sent } = makeNotifier(() => current, async () => ({ ok: true }));
    await notifier.tick();
    expect(sent).toHaveLength(0);
    notifier.stop();
  });

  test("send failure does not break subsequent ticks", async () => {
    const current: NotifierSnapshot[] = [
      { id: "a", name: "a", url: "http://a", telegram: target, sessions: { s1: { state: "running" } } },
    ];
    const { notifier, sent } = makeNotifier(() => current, async () => {
      throw new Error("boom");
    });
    await expect(notifier.tick()).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    notifier.stop();
  });

  test("collect() throwing does not break the loop", async () => {
    let fail = true;
    const notifier = createSessionNotifier({
      collect: async () => {
        if (fail) throw new Error("collect boom");
        return [
          { id: "a", name: "a", url: "http://a", telegram: target, sessions: { s1: { state: "running" } } },
        ];
      },
      send: async () => ({ ok: true }),
      intervalMs: 3600_000,
    });
    await expect(notifier.tick()).resolves.toBeUndefined();
    fail = false;
    await expect(notifier.tick()).resolves.toBeUndefined();
    notifier.stop();
  });

  test("start/stop toggles running flag", () => {
    const notifier = createSessionNotifier({
      collect: async () => [],
      send: async () => ({ ok: true }),
      intervalMs: 3600_000,
    });
    expect(notifier.running).toBe(false);
    notifier.start();
    expect(notifier.running).toBe(true);
    notifier.stop();
    expect(notifier.running).toBe(false);
  });
});
