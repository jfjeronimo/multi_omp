import { afterAll, describe, expect, test } from "bun:test";
import { FileNodeStore } from "../src/store";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("FileNodeStore persistence", () => {
  let dir: string;
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeStore(): Promise<{ store: FileNodeStore; file: string }> {
    dir = await mkdtemp(join(tmpdir(), "multi-omp-test-"));
    const file = join(dir, "nodes.json");
    const store = new FileNodeStore(file);
    await store.load();
    return { store, file };
  }

  test("add persists; a fresh store loads the same node", async () => {
    const { store, file } = await makeStore();
    store.add({ id: "rasp", name: "Raspberry", url: "http://192.168.1.20:30141", password: "pw" });

    const fresh = new FileNodeStore(file);
    await fresh.load();
    const loaded = fresh.get("rasp");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Raspberry");
    expect(loaded!.password).toBe("pw");
  });

  test("file is created with 0600 perms", async () => {
    const { store, file } = await makeStore();
    store.add({ id: "a", name: "A", url: "http://10.0.0.1:30141" });
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("load tolerates a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "multi-omp-test-"));
    const store = new FileNodeStore(join(dir, "nope", "nodes.json"));
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  test("load rejects corrupt json", async () => {
    dir = await mkdtemp(join(tmpdir(), "multi-omp-test-"));
    const file = join(dir, "nodes.json");
    await Bun.write(file, "{not json");
    const store = new FileNodeStore(file);
    await expect(store.load()).rejects.toThrow(/Corrupt node store/);
  });

  test("update and remove persist", async () => {
    const { store, file } = await makeStore();
    store.add({ id: "a", name: "A", url: "http://10.0.0.1:30141" });
    store.update("a", { name: "A2" });

    const fresh = new FileNodeStore(file);
    await fresh.load();
    expect(fresh.get("a")!.name).toBe("A2");

    store.remove("a");
    const fresh2 = new FileNodeStore(file);
    await fresh2.load();
    expect(fresh2.list()).toHaveLength(0);
  });
});
