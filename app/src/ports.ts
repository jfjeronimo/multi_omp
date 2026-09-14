/**
 * Local port allocation for per-node proxy listeners.
 *
 * Ports are stable across gateway restarts (stored on the node record) and
 * allocated from a fixed range (default 30200-30299). The allocator never
 * hands out a port that is already in use by multi-omp, and the gateway
 * verifies availability by actually binding before it commits to a port.
 */
import * as fs from "node:fs";
import { isIP } from "node:net";

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

/**
 * Resolve a bind target to an IP literal. `Bun.serve({ hostname })` with a
 * *hostname* (FQDN, e.g. "maat.menfis") makes the runtime resolve the name
 * and bind whatever address it maps to. Inside a container that is the
 * machine's LAN/bridge IP — not an address of the container's network
 * namespace — so the kernel rejects the bind (EADDRNOTAVAIL; some Bun
 * versions surface it as EADDRINUSE with errno 0) and no socket is ever
 * created in /proc.
 *
 * IPs pass through untouched ("0.0.0.0", "127.0.0.1", "::", …). Any other
 * value is resolved via DNS; an IPv4 address is preferred when available
 * (IPv6 loopback exists even where the interface has no IPv6).
 *
 * @throws with an actionable message when the name cannot be resolved.
 */
export async function resolveBindHost(host: string): Promise<string> {
  if (isIP(host) !== 0) return host;
  let addrs: { address: string; family: number }[];
  try {
    addrs = await Bun.dns.lookup(host);
  } catch (e) {
    throw new Error(
      `multi-omp: cannot resolve bind host "${host}" (${(e as Error).message}); ` +
        `set MULTI_OMP_HOST to an IP address (0.0.0.0 in Docker) instead of a hostname`,
    );
  }
  if (addrs.length === 0) {
    throw new Error(
      `multi-omp: bind host "${host}" resolved to no address; ` +
        `set MULTI_OMP_HOST to an IP address (0.0.0.0 in Docker) instead of a hostname`,
    );
  }
  const ip = (addrs.find((a) => a.family === 4) ?? addrs[0]).address;
  console.warn(`multi-omp: bind host "${host}" resolved to ${ip}`);
  return ip;
}

/**
 * IPv4 addresses that are local to this network namespace, straight from the
 * kernel's routing trie. Lines look like:
 *
 *   |-- 172.20.0.2
 *      /32 host LOCAL
 *
 * The IP sits on the `|-- IP` line and the marker on the one below it. The
 * set always contains 127.0.0.1; inside a container it contains the
 * container's interface IPs and NOT the host's LAN IP.
 *
 * Returns an empty set when /proc/net/fib_trie is unreadable (non-Linux);
 * callers must treat "unknown" as "don't interfere" (pass the IP through).
 */
export function localIpv4s(): Set<string> {
  const locals = new Set<string>();
  try {
    const lines = fs.readFileSync("/proc/net/fib_trie", "utf8").split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const m = lines[i].match(/^\s*\|--\s+(\d+\.\d+\.\d+\.\d+)$/);
      if (m && /\/32 host LOCAL/.test(lines[i + 1])) locals.add(m[1]);
    }
  } catch {
    return new Set<string>();
  }
  return locals;
}

/**
 * True when `ip` can be bound in this network namespace:
 * - wildcards (0.0.0.0, ::) are always fine;
 * - IPv4: must appear in /proc/net/fib_trie (unknown set = non-Linux → fine);
 * - IPv6: assumed fine (no cheap local enumeration; a wrong guess fails the
 *   bind loudly instead of silently re-binding).
 */
export function isLocalBindIp(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "::") return true;
  if (isIP(ip) === 6) return true;
  const locals = localIpv4s();
  if (locals.size === 0) return true; // non-Linux: don't interfere
  return locals.has(ip);
}

/**
 * Choose the final bind host for `Bun.serve`.
 *
 * The full chain for the container case that used to crash-loop:
 * MULTI_OMP_HOST="maat.menfis" → resolves to the host LAN IP 172.16.10.102 →
 * not an address of the container's netns → the kernel refuses the bind and
 * the gateway died every start. The intent behind "bind the machine's IP"
 * from inside a container is "be reachable from outside the machine", and
 * 0.0.0.0 achieves exactly that through Docker's port publishing — so a
 * non-local IPv4 target falls back to 0.0.0.0 with a loud warning instead
 * of crashing.
 */
export async function selectBindHost(rawHost: string): Promise<string> {
  const ip = await resolveBindHost(rawHost);
  if (isLocalBindIp(ip)) return ip;
  const locals = [...localIpv4s()].sort().join(", ") || "unknown";
  console.warn(
    `multi-omp: "${rawHost}" → ${ip} is not an address of this environment ` +
      `(local: ${locals}); binding 0.0.0.0 instead. ` +
      `Inside Docker, set MULTI_OMP_HOST=0.0.0.0.`,
  );
  return "0.0.0.0";
}

/* -------------------------------------------------------------------------- */
/* Control-plane port diagnosis                                                */
/* -------------------------------------------------------------------------- */

/** Max number of sockets (per family) reported by diagnosePortHeld. */
const MAX_SOCKETS_REPORTED = 5;
/** Max number of fds scanned per /proc/<pid>/fd while mapping inodes to PIDs. */
const MAX_FDS_PER_PROC = 4096;

/** A socket entry pulled from /proc/net/tcp{,6}. */
interface NetTcpSocket {
  family: "v4" | "v6";
  local: { ip: string; port: number };
  state: string;
  inode: number;
}

/**
 * Decode a /proc/net/tcp local_address ("HEXIP:HEXPORT") into { ip, port }.
 * IPv4: 8 hex chars, 4 bytes least-significant byte first (0100007F → 127.0.0.1).
 * IPv6: 32 hex chars, four 32-bit words each printed with their 16-bit
 * halves swapped, and each 16-bit group with its two bytes swapped.
 * Returns null when the format is not recognized.
 */
function parseLocalAddress(addr: string): { ip: string; port: number } | null {
  const colon = addr.lastIndexOf(":");
  if (colon < 0) return null;
  const ipHex = addr.slice(0, colon);
  const portHex = addr.slice(colon + 1);
  if (portHex.length !== 4) return null;
  const port = parseInt(portHex, 16);
  if (!Number.isFinite(port)) return null;
  if (ipHex.length === 8) {
    // Little-endian per byte: read bytes right-to-left.
    const octets = [3, 2, 1, 0].map((i) => parseInt(ipHex.slice(i * 2, i * 2 + 2), 16));
    if (octets.some((o) => !Number.isFinite(o))) return null;
    return { ip: octets.join("."), port };
  }
  if (ipHex.length === 32) {
    // Four 32-bit words, each printed with its two 16-bit halves swapped;
    // each 16-bit group additionally has its two bytes swapped. Undo both
    // to recover the 8 network-order 16-bit groups.
    const groups: string[] = [];
    for (let w = 0; w < 4; w++) {
      const word = ipHex.slice(w * 8, w * 8 + 8);
      const halves = [word.slice(4, 8), word.slice(0, 4)];
      for (const h of halves) groups.push((h.slice(2, 4) + h.slice(0, 2)).toUpperCase());
    }
    return { ip: formatIpv6(groups), port };
  }
  return null;
}

/**
 * Render the 8 four-hex-char groups of an IPv6 address per the basic
 * RFC 5952 algorithm: omit leading zeros in each group (at least one
 * digit remains), then replace the longest run of all-zero groups
 * (length >= 2; the first run on a tie) with `::`. A single zero group
 * is not compressed.
 */
function formatIpv6(groups: string[]): string {
  const trim = (g: string) => g.replace(/^0+(?=.)/, "") || "0";
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < groups.length) {
    if (groups[i] !== "0000") {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === "0000") j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map(trim).join(":");
  const head = groups.slice(0, bestStart).map(trim).join(":");
  const tail = groups.slice(bestStart + bestLen).map(trim).join(":");
  return head + "::" + tail;
}

/** Parse one /proc/net/tcp{,6} file for entries whose local port matches. */
function readNetTcp(file: string, family: "v4" | "v6", port: number): NetTcpSocket[] {
  const out: NetTcpSocket[] = [];
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt inode ...
    if (fields.length < 10) continue;
    const local = parseLocalAddress(fields[1]);
    if (local === null || local.port !== port) continue;
    const inode = Number(fields[9]);
    if (!Number.isFinite(inode)) continue;
    out.push({ family, local: { ip: local.ip, port }, state: fields[3], inode });
    if (out.length >= MAX_SOCKETS_REPORTED) break;
  }
  return out;
}

/**
 * Map a socket inode to the PID that holds it by scanning /proc/[pid]/fd.
 * `truncated` reports that some process held more than MAX_FDS_PER_PROC fds
 * (only the first were scanned), and `denied` that some process' fd table
 * could not be read (permissions) — both mean the holder may be hidden even
 * when `holder` is null. Only null when /proc itself could not be listed.
 */
function inodeToPid(inode: number): { holder: { pid: number; cmdline: string; comm: string } | null; truncated: boolean; denied: boolean } | null {
  if (inode <= 0) return null;
  const target = `socket:[${inode}]`;
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(String(name)));
  } catch {
    return null;
  }
  let truncated = false;
  let denied = false;
  for (const pidName of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pidName}/fd`);
    } catch (e) {
      // Permission denied on another process' fd table: note it and move on.
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EACCES" || code === "EPERM") denied = true;
      continue;
    }
    if (fds.length > MAX_FDS_PER_PROC) {
      truncated = true;
      fds = fds.slice(0, MAX_FDS_PER_PROC);
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(`/proc/${pidName}/fd/${fd}`);
      } catch {
        continue;
      }
      if (link !== target) continue;
      let cmdline = "";
      let comm = "";
      try {
        cmdline = fs.readFileSync(`/proc/${pidName}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 120);
      } catch {
        /* unreadable cmdline: leave empty */
      }
      try {
        comm = fs.readFileSync(`/proc/${pidName}/comm`, "utf8").trim();
      } catch {
        /* unreadable comm: leave empty */
      }
      return { holder: { pid: Number(pidName), cmdline, comm }, truncated, denied };
    }
  }
  return { holder: null, truncated, denied };
}

/**
 * Diagnose why `port` is busy, reading /proc/net/tcp{,6} and /proc/[pid]/fd
 * from inside the current network namespace. Returns a multi-line string,
 * ready for console.error, that identifies the socket holder when visible in
 * this namespace and always ends with actionable steps (Docker commands to
 * find/stop a duplicate old container, or ss on the host when the holder is
 * outside this namespace). Never throws.
 */
export function diagnosePortHeld(port: number, hostname: string): string {
  const hexPort = ":" + port.toString(16);
  const lines: string[] = [];
  lines.push(`multi-omp: port ${port} (hex ${hexPort}) on ${hostname} is busy; what is holding it:`);

  let sockets: NetTcpSocket[];
  try {
    sockets = [...readNetTcp("/proc/net/tcp", "v4", port), ...readNetTcp("/proc/net/tcp6", "v6", port)];
  } catch {
    sockets = [];
  }

  if (sockets.length === 0) {
    lines.push(`  multi-omp: no socket for ${hexPort} visible in /proc/net/tcp{,6}`);
    lines.push(`  multi-omp: the holder is outside this network namespace (e.g. the host, or another container)`);
    lines.push(`  multi-omp: from the host, verify with: ss -ltnp | grep :${port}`);
  } else {
    for (const sock of sockets) {
      const family = sock.family === "v6" ? "[v6]" : "[v4]";
      lines.push(`  multi-omp: ${family} ${sock.local.ip}:${sock.local.port} state=${sock.state} inode=${sock.inode}`);
      const scan = inodeToPid(sock.inode);
      const holder = scan?.holder;
      if (holder) {
        lines.push(`  multi-omp:   held by pid ${holder.pid} (${holder.comm}): ${holder.cmdline}`);
        if (holder.cmdline.includes("multi-omp") || holder.cmdline.includes("src/index.ts")) {
          lines.push(`  multi-omp:   -> another multi-omp instance (old container?) is holding the port`);
        } else if (holder.pid === 1) {
          // PID 1 alone is not evidence (it can be any app's entrypoint):
          // only label it softly when comm/cmdline show no multi-omp marker.
          lines.push(`  multi-omp:   -> possibly another instance of this app (pid 1 holds the port) — check docker ps for a stale container`);
        }
      } else {
        if (scan?.truncated) {
          lines.push(`  multi-omp:   (note: some process was skipped because it holds more than 4096 fds — the holder may be that process)`);
        }
        if (scan?.denied) {
          lines.push(`  multi-omp:   no process in this namespace holds that inode (kernel socket, a process we lack permission to read (e.g. a root process in this container), or holder is outside the network namespace)`);
          lines.push(`  multi-omp:   from the host, verify with: ss -ltnp | grep :${port}`);
        } else {
          lines.push(`  multi-omp:   no process in this namespace holds that inode (kernel socket, or holder is outside the network namespace)`);
          lines.push(`  multi-omp:   from the host, verify with: ss -ltnp | grep :${port}`);
        }
      }
    }
  }

  // Fixed, actionable guidance — always printed.
  lines.push(`  multi-omp: next steps:`);
  lines.push(`  multi-omp:   1. find a duplicate / stale container: docker ps -a --filter ancestor=<image>  (or: docker compose ps)`);
  lines.push(`  multi-omp:   2. confirm the socket inside the old container: docker exec <old-container> cat /proc/net/tcp | grep '${hexPort}'`);
  lines.push(`  multi-omp:   3. stop it: docker stop <old-container>, then start the new one`);
  lines.push(`  multi-omp:   4. if nothing in any container holds ${hexPort}, the port is taken on the host: ss -ltnp | grep :${port}`);
  lines.push(`  multi-omp:      (then stop the host process, or change the port with PORT=<new-port>)`);

  return lines.join("\n");
}
