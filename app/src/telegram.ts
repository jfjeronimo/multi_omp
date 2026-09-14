/**
 * Telegram notifications for per-node events.
 *
 * A node can carry an optional bot token + chat id. The notifier (created by
 * the gateway) polls each node's omp-web session API on a fixed interval and
 * sends a Telegram message when a tracked session transitions between
 * states that matter to the user:
 *
 *   - finished:  the session was running and is no longer running,
 *   - waiting:   the agent finished a turn and is waiting for the user
 *                (no turn running, pending prompt queue non-empty),
 *   - resumed:   the agent picked up a pending prompt and is running again.
 *
 * State is keyed per (node id, session id); each (node, session, state)
 * combination is delivered at most once until the session leaves that state.
 * Only the three transitions above notify — e.g. a session that stops
 * waiting without resuming (idle) does not send a message.
 * The bot token never leaves the gateway: the notifier runs server-side and
 * the browser only sees a masked token.
 */

import type { OmpNode } from "./store";
import { authHeadersFor } from "./store";

export interface TelegramTarget {
  token: string;
  chatId: string;
}

export interface TelegramResult {
  ok: boolean;
  error?: string;
}

/**
 * The per-session transitions the notifier can announce. One kind per
 * transition `diffTransitions` detects; `EVENT_KIND_BY_STATE` maps the
 * notifier state the transition lands in to its kind.
 */
export type TelegramEventKind = "started" | "waiting" | "finished" | "stopped";

/** Notifier states whose transitions are announced, mapped to their kind. */
const EVENT_KIND_BY_STATE: Record<NotifierState, TelegramEventKind> = {
  running: "started",
  waiting: "waiting",
  idle: "finished",
  stopped: "stopped",
};

/** The full set of kinds, in display order. */
export const TELEGRAM_EVENT_KINDS: readonly TelegramEventKind[] = [
  "started",
  "waiting",
  "finished",
  "stopped",
];

const isKind = (v: unknown): v is TelegramEventKind =>
  typeof v === "string" && (TELEGRAM_EVENT_KINDS as readonly string[]).includes(v);

/**
 * Coerce a persisted/supplied `telegramEvents` value into the ordered list
 * of enabled kinds. Tolerant on purpose (it parses user and on-disk JSON):
 * - `undefined` / empty / not an array -> all kinds enabled (default),
 * - arrays keep only known kinds, in canonical order, de-duplicated,
 * - an empty result (e.g. `["bogus"]`) falls back to the default.
 */
export function normalizeTelegramEvents(raw: unknown): TelegramEventKind[] {
  if (!Array.isArray(raw)) return [...TELEGRAM_EVENT_KINDS];
  const enabled = TELEGRAM_EVENT_KINDS.filter((k) => raw.includes(k));
  return enabled.length > 0 ? enabled : [...TELEGRAM_EVENT_KINDS];
}

/** True when `kinds` enables every kind (i.e. nothing is filtered). */
export function allTelegramEventsEnabled(kinds?: readonly TelegramEventKind[]): boolean {
  const list = normalizeTelegramEvents(kinds);
  return list.length === TELEGRAM_EVENT_KINDS.length;
}

/**
 * Validate an API payload `telegramEvents` value. Accepts an array of the
 * known kind strings (empty array = "announce everything" = default);
 * anything else is rejected with a user-facing message. Returns the
 * normalized list, or `undefined` when the caller wants the default.
 */
export function parseTelegramEventsParam(raw: unknown): TelegramEventKind[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.every(isKind)) {
    throw new Error(
      `telegramEvents must be an array of: ${TELEGRAM_EVENT_KINDS.join(", ")}`,
    );
  }
  return raw.length > 0 ? [...new Set(raw)] : [...TELEGRAM_EVENT_KINDS];
}

/**
 * Send a Telegram message via the Bot API. Returns a result object; never
 * throws (the notifier must survive any failure). A 401/403 means the token
 * or chat id is wrong and is reported distinctly.
 */
export async function sendTelegram(
  target: TelegramTarget,
  text: string,
  timeoutMs = 8000,
): Promise<TelegramResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${target.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target.chatId, text }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      const detail = res.status === 401 || res.status === 403
        ? ` (token or chat id wrong, HTTP ${res.status})`
        : "";
      return { ok: false, error: `${body.description ?? `HTTP ${res.status}`}${detail}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Session states the notifier tracks: active work, done awaiting reply, or finished. */
export type NotifierState = "running" | "waiting" | "idle" | "stopped";
export interface NotifierSnapshot {
  id: string;
  name: string;
  /** Local port the node is proxied on (for the deep link). */
  port?: number;
  url: string;
  telegram: TelegramTarget | null;
  /**
   * Per-node allow-list of announced transitions. Absent or empty list =
   * all kinds announced (the default); unknown entries are ignored by
   * `normalizeTelegramEvents`.
   */
  telegramEvents?: TelegramEventKind[];
  /** Per session: its classified state (running work / awaiting reply / idle) + display name. */
  sessions: Record<string, { state: "running" | "waiting" | "idle"; name?: string }>;
}

export interface NotifierOptions {
  /** Collect snapshots of every node (including its telegram target). */
  collect(): Promise<NotifierSnapshot[]>;
  /** Send one message for the node's telegram target. */
  send(nodeId: string, text: string): Promise<TelegramResult>;
  /** Interval between polls. */
  intervalMs?: number;
  /** Test hook: sleep between polls (real clock by default). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionNotifier {
  /** Run one poll cycle (also called automatically while the loop is on). */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  /** True between start() and stop() — used by tests. */
  readonly running: boolean;
}

function classify(snap: NotifierSnapshot): Record<string, NotifierState> {
  const out: Record<string, NotifierState> = {};
  for (const [sid, s] of Object.entries(snap.sessions)) out[sid] = s.state;
  return out;
}

/**
 * Diff per-session states between two consecutive polls and return the
 * transitions worth notifying:
 *   - idle/undefined -> running : the session picked up work ("arrancó"),
 *   - running -> idle           : the agent finished a turn ("finalizó"),
 *   - running -> waiting        : the agent finished and there are queued
 *                                 prompts to answer ("espera tu respuesta").
 * A session that disappears (was running/waiting, now absent) is "stopped".
 */
export function diffTransitions(
  prev: Map<string, Record<string, NotifierState>>,
  next: NotifierSnapshot[],
): Array<{ nodeId: string; session: string; state: NotifierState; name?: string }> {
  const events: Array<{ nodeId: string; session: string; state: NotifierState; name?: string }> = [];
  for (const snap of next) {
    const before = prev.get(snap.id);
    const after = classify(snap);
    const seen = new Set<string>([...(before ? Object.keys(before) : []), ...Object.keys(after)]);
    for (const sid of seen) {
      const from = before?.[sid];
      const to = after[sid];
      const name = snap.sessions[sid]?.name;
      if (to === "running" && from !== "running") {
        events.push({ nodeId: snap.id, session: sid, state: "running", name });
      } else if (from === "running" && to === "idle") {
        events.push({ nodeId: snap.id, session: sid, state: "idle", name });
      } else if (from === "running" && to === "waiting") {
        events.push({ nodeId: snap.id, session: sid, state: "waiting", name });
      } else if (to === undefined && (from === "running" || from === "waiting")) {
        events.push({ nodeId: snap.id, session: sid, state: "stopped" });
      }
    }
  }
  return events;
}

export function createSessionNotifier(opts: NotifierOptions): SessionNotifier {
  const intervalMs = opts.intervalMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const prev = new Map<string, Record<string, NotifierState>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let busy = false;
  function messageText(snap: NotifierSnapshot, ev: { session: string; state: NotifierState; name?: string }): string {
    // Deep link: the node's own host (from its registry URL) on the gateway's
    // proxy port for it, so the link works from any device. Falls back to the
    // node's direct URL when no proxy port is assigned.
    let link = snap.url;
    if (typeof snap.port === "number") {
      try {
        const u = new URL(snap.url);
        link = `${u.protocol}//${u.host.split(":")[0]}:${snap.port}/`;
      } catch {
        // Malformed registry URL: keep the direct URL.
      }
    }
    const title = ev.name ?? ev.session;
    const head = `multi-omp · ${snap.name}`;
    switch (ev.state) {
      case "running":
        return `${head}\nSesión «${title}» arrancó.\n${link}`;
      case "waiting":
        return `${head}\nSesión «${title}» terminó — hay preguntas pendientes, el agente espera tu respuesta.\n${link}`;
      case "idle":
        return `${head}\nSesión «${title}» finalizó su turno.\n${link}`;
      case "stopped":
        return `${head}\nSesión «${title}» ya no está activa.\n${link}`;
    }
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const snaps = await opts.collect();
      const events = diffTransitions(prev, snaps);
      prev.clear();
      for (const snap of snaps) prev.set(snap.id, classify(snap));
      // One message per node: group that node's events into a single text,
      // skipping kinds the node has disabled (absent list = all enabled).
      const snapById = new Map(snaps.map((s) => [s.id, s]));
      const eventNodeIds = [...new Set(events.map((e) => e.nodeId))];
      for (const nodeId of eventNodeIds) {
        const snap = snapById.get(nodeId);
        if (!snap?.telegram) continue;
        const enabled = normalizeTelegramEvents(snap.telegramEvents);
        const evs = events.filter(
          (e) => e.nodeId === nodeId && enabled.includes(EVENT_KIND_BY_STATE[e.state]),
        );
        if (evs.length === 0) continue;
        const text = evs.map((e) => messageText(snap, e)).join("\n\n");
        const res = await opts.send(nodeId, text);
        if (!res.ok) console.error(`multi-omp: telegram notify for ${nodeId} failed: ${res.error}`);
      }
    } catch (e) {
      console.error(`multi-omp: notifier tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }

  function loop(): void {
    if (!running) return;
    void tick().finally(() => {
      if (running) void sleep(intervalMs).then(loop);
    });
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
    },
    get running() {
      return running;
    },
  };
}

/**
 * Build the snapshot collector used by the gateway: fetches each node's
 * sessions list + running ids and the per-session state of every running
 * session, then classifies. A node that is down or has no sessions yields an
 * empty `sessions` map (its sessions simply stop notifying).
 */
export function nodeSnapshot(
  node: OmpNode,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<Omit<NotifierSnapshot, "telegram">> {
  const headers = authHeadersFor(node) ?? {};
  const withTimeout = (url: string) =>
    fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  return (async () => {
    const base: Omit<NotifierSnapshot, "telegram"> = {
      id: node.id,
      name: node.name,
      port: node.port,
      url: node.url,
      sessions: {},
    };
    try {
      const res = await withTimeout(`${node.url}/api/sessions`);
      if (!res.ok) return base;
      const data = (await res.json()) as {
        sessions?: Array<{ id: string; name?: string }>;
        runningSessionIds?: string[];
      };
      const names: Record<string, string | undefined> = {};
      for (const s of data.sessions ?? []) names[s.id] = s.name;
      const result: Omit<NotifierSnapshot, "telegram"> = { ...base };
      await Promise.all(
        (data.runningSessionIds ?? []).map(async (sid) => {
          let state: "running" | "waiting" | "idle" = "running";
          try {
            const r = await withTimeout(`${node.url}/api/sessions/${encodeURIComponent(sid)}/state`);
            if (r.ok) {
              const d = (await r.json()) as {
                running?: boolean;
                state?: { isPromptRunning?: boolean; pendingMessageCount?: number };
              };
              const st = d.state;
              if (d.running === true) {
                if (!st?.isPromptRunning && (st?.pendingMessageCount ?? 0) > 0) state = "waiting";
                else if (!st?.isPromptRunning) state = "idle";
              } else {
                state = "idle";
              }
            }
          } catch {
            // Unreachable state: keep the session counted as running.
          }
          result.sessions[sid] = { state, name: names[sid] };
        }),
      );
      return result;
    } catch {
      return base;
    }
  })();
}
