/**
 * Node registry: which omp-web instances the gateway knows about.
 *
 * Stored as JSON (default: ~/.omp/multi-omp/nodes.json, override with
 * MULTI_OMP_HOME). Each node:
 *   { id, name, url, username?, password? }
 *
 * `url` is the origin of the node, e.g. "http://192.168.1.20:30141".
 * Credentials are stored locally on the gateway machine only; the browser
 * never sees them.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface FsError extends Error {
  code?: string;
}

export interface OmpNode {
  /** Stable identifier used in URLs, e.g. "raspberry". */
  id: string;
  /** Display name for the UI, e.g. "Raspberry — pi". */
  name: string;
  /** Origin of the node: "http://host:port". */
  url: string;
  /** Basic-auth username (omp-web fixed default: "omp"). */
  username?: string;
  /** Basic-auth password (plaintext, local file 0600 only). */
  password?: string;
  /** Optional note shown in the dashboard. */
  note?: string;
  /** Local port the gateway listens on to proxy this node. */
  port?: number;
}

export interface NodeStore {
  get(id: string): OmpNode | undefined;
  list(): OmpNode[];
  add(node: OmpNode): OmpNode;
  update(id: string, patch: Partial<OmpNode>): OmpNode;
  remove(id: string): boolean;
}

/** Validate a node origin. Throws Error with a user-facing message. */
export function assertValidUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid URL "${raw}" — expected e.g. http://192.168.1.20:30141`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${u.protocol}" — only http/https`);
  }
  if (!u.hostname) throw new Error(`Empty host in "${raw}"`);
  // Build origin manually: the `origin` getter re-initializes pathname.
  const defPort = u.protocol === "https:" ? 443 : 80;
  const port = u.port && Number(u.port) !== defPort ? `:${u.port}` : "";
  return `${u.protocol}//${u.hostname}${port}`;
}

/** Generate a unique, URL-safe id from a name or url. */
export function slugify(input: string, taken: Set<string>): string {
  const base =
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Validate a node id segment (lowercase, digits, dashes, 1-64 chars, no leading/trailing dash). */
export function parseNodeId(segment: string): string | null {
  if (segment.length > 64) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(segment)) return null;
  return segment;
}

/** Basic-auth header for a node, or undefined when the node has no password. */
export function authHeadersFor(node: OmpNode): Record<string, string> | undefined {
  if (node.password !== undefined && node.password !== "") {
    return {
      Authorization: `Basic ${btoa(`${node.username ?? "omp"}:${node.password}`)}`,
    };
  }
  return undefined;
}

export class FileNodeStore implements NodeStore {
  private file: string;
  private nodes = new Map<string, OmpNode>();

  /** @param file path of the JSON store (created on first write, mode 0600). */
  constructor(file: string) {
    this.file = file;
  }

  /** Load nodes from disk. Idempotent; call before serving requests. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await Bun.file(this.file).text();
    } catch (e) {
      if ((e as FsError).code === "ENOENT") return;
      throw new Error(`Failed to read node store at ${this.file}: ${(e as Error).message}`);
    }
    let data: { nodes?: OmpNode[] };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt node store at ${this.file} — not valid JSON`);
    }
    for (const n of data.nodes ?? []) {
      if (n && typeof n.id === "string" && typeof n.url === "string") {
        this.nodes.set(n.id, n);
      }
    }
  }

  private persist(): void {
    const body = JSON.stringify({ version: 1, nodes: [...this.nodes.values()] }, null, 2) + "\n";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, body, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (e) {
      console.error(`multi-omp: failed to persist node store: ${(e as Error).message}`);
    }
  }

  get(id: string): OmpNode | undefined {
    return this.nodes.get(id);
  }

  list(): OmpNode[] {
    return [...this.nodes.values()];
  }

  add(node: OmpNode): OmpNode {
    const clean: OmpNode = {
      ...node,
      url: assertValidUrl(node.url),
      id: node.id || slugify(node.name || node.url, new Set(this.nodes.keys())),
    };
    if (this.nodes.has(clean.id)) {
      throw new Error(`A node with id "${clean.id}" already exists`);
    }
    this.nodes.set(clean.id, clean);
    this.persist();
    return clean;
  }

  update(id: string, patch: Partial<OmpNode>): OmpNode {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`Unknown node "${id}"`);
    const next: OmpNode = { ...current, ...patch, id };
    if (patch.url !== undefined) next.url = assertValidUrl(patch.url);
    this.nodes.set(id, next);
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const had = this.nodes.delete(id);
    if (had) this.persist();
    return had;
  }
}

/** In-memory store for tests. */
export class MemoryNodeStore implements NodeStore {
  private nodes = new Map<string, OmpNode>();

  get(id: string): OmpNode | undefined {
    return this.nodes.get(id);
  }
  list(): OmpNode[] {
    return [...this.nodes.values()];
  }
  add(node: OmpNode): OmpNode {
    const clean = { ...node, url: assertValidUrl(node.url) };
    if (!clean.id) clean.id = slugify(node.name || node.url, new Set(this.nodes.keys()));
    if (this.nodes.has(clean.id)) throw new Error(`A node with id "${clean.id}" already exists`);
    this.nodes.set(clean.id, clean);
    return clean;
  }
  update(id: string, patch: Partial<OmpNode>): OmpNode {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`Unknown node "${id}"`);
    const next = { ...current, ...patch, id };
    if (patch.url !== undefined) next.url = assertValidUrl(patch.url);
    this.nodes.set(id, next);
    return next;
  }
  remove(id: string): boolean {
    return this.nodes.delete(id);
  }
}
