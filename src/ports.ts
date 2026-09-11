/**
 * Local port allocation for per-node proxy listeners.
 *
 * Ports are stable across gateway restarts (stored on the node record) and
 * allocated from a fixed range (default 30200-30299). The allocator never
 * hands out a port that is already in use by multi-omp, and the gateway
 * verifies availability by actually binding before it commits to a port.
 */

/** First local port handed out to a node (inclusive). */
export const FIRST_NODE_PORT = 30200;
/** Last local port a node may take (inclusive). */
export const LAST_NODE_PORT = 30299;

/** Yield every port in [first, last] in order. */
export function* rangePorts(first: number, last: number): Generator<number> {
  for (let p = first; p <= last; p++) yield p;
}

/**
 * Pick the first port in [first, last] not in `used`. Returns null when the
 * range is exhausted. Callers must still verify the port binds (the OS may
 * hold a port this process cannot see).
 */
export function allocatePort(used: ReadonlySet<number>, first = FIRST_NODE_PORT, last = LAST_NODE_PORT): number | null {
  for (const p of rangePorts(first, last)) {
    if (!used.has(p)) return p;
  }
  return null;
}

/**
 * Try to bind `port` with a throwaway server; return true when it is free.
 * The probe server is stopped immediately, so the result is a best-effort
 * availability check (a real bind is the only reliable test).
 */
export function probePortFree(port: number, hostname = "127.0.0.1"): boolean {
  try {
    const s = Bun.serve({ port, hostname, fetch: () => new Response() });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}
