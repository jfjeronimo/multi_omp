/**
 * Local port allocation for per-node proxy listeners.
 *
 * Ports are stable across gateway restarts (stored on the node record) and
 * allocated from a fixed range (default 30200-30299). The allocator never
 * hands out a port that is already in use by multi-omp, and the gateway
 * verifies availability by actually binding before it commits to a port.
 */

/** Yield every port in [first, last] in order. */
export function* rangePorts(first: number, last: number): Generator<number> {
  for (let p = first; p <= last; p++) yield p;
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
