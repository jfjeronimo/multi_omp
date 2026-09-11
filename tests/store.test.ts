import { describe, expect, test } from "bun:test";
import { assertValidUrl, slugify, parseNodeId, MemoryNodeStore, authHeadersFor } from "../src/store";

describe("assertValidUrl", () => {
  test("normalizes http origin", () => {
    expect(assertValidUrl("http://192.168.1.20:30141")).toBe("http://192.168.1.20:30141");
  });
  test("strips trailing slash and path", () => {
    expect(assertValidUrl("http://host:30141/")).toBe("http://host:30141");
    expect(assertValidUrl("http://host:30141/foo")).toBe("http://host:30141");
  });
  test("drops default ports", () => {
    expect(assertValidUrl("http://host:80")).toBe("http://host");
    expect(assertValidUrl("https://host:443")).toBe("https://host");
  });
  test("accepts ipv6", () => {
    expect(assertValidUrl("http://[::1]:30141")).toBe("http://[::1]:30141");
  });
  test("trims whitespace", () => {
    expect(assertValidUrl("  http://host:30141  ")).toBe("http://host:30141");
  });
  test("rejects unsupported protocol", () => {
    expect(() => assertValidUrl("ftp://host:21")).toThrow(/Unsupported protocol/);
    expect(() => assertValidUrl("wss://host:443")).toThrow(/Unsupported protocol/);
  });
  test("rejects garbage", () => {
    expect(() => assertValidUrl("not a url")).toThrow(/Invalid URL/);
  });
  test("rejects empty host", () => {
    expect(() => assertValidUrl("http://:30141")).toThrow(/Empty host|Invalid URL/);
  });
});

describe("slugify", () => {
  test("lowercases and dashes", () => {
    expect(slugify("My Raspberry Pi", new Set())).toBe("my-raspberry-pi");
  });
  test("appends suffix on collision", () => {
    const taken = new Set(["node", "node-2"]);
    expect(slugify("node", taken)).toBe("node-3");
  });
  test("empty falls back to 'node'", () => {
    expect(slugify("!!!", new Set())).toBe("node");
  });
});

describe("parseNodeId", () => {
  test("accepts valid ids", () => {
    expect(parseNodeId("raspberry")).toBe("raspberry");
    expect(parseNodeId("a-b-2")).toBe("a-b-2");
    expect(parseNodeId("node42")).toBe("node42");
  });
  test("rejects bad ids", () => {
    expect(parseNodeId("")).toBeNull();
    expect(parseNodeId("UPPER")).toBeNull();
    expect(parseNodeId("-lead")).toBeNull();
    expect(parseNodeId("trail-")).toBeNull();
    expect(parseNodeId("has space")).toBeNull();
    expect(parseNodeId("has/slash")).toBeNull();
    expect(parseNodeId("a".repeat(65))).toBeNull();
  });
});

describe("authHeadersFor", () => {
  test("returns undefined without password", () => {
    expect(authHeadersFor({ id: "a", name: "a", url: "http://h:1" })).toBeUndefined();
  });
  test("builds basic auth with default username 'omp'", () => {
    const h = authHeadersFor({ id: "a", name: "a", url: "http://h:1", password: "secret" });
    expect(h).toBeDefined();
    const expected = "Basic " + Buffer.from("omp:secret").toString("base64");
    expect(h!.Authorization).toBe(expected);
  });
  test("respects custom username", () => {
    const h = authHeadersFor({ id: "a", name: "a", url: "http://h:1", username: "bob", password: "pw" });
    const expected = "Basic " + Buffer.from("bob:pw").toString("base64");
    expect(h!.Authorization).toBe(expected);
  });
});

describe("MemoryNodeStore", () => {
  test("add/list/get/remove", () => {
    const s = new MemoryNodeStore();
    const n = s.add({ id: "raspberry", name: "Raspberry", url: "http://192.168.1.20:30141" });
    expect(n.id).toBe("raspberry");
    expect(n.url).toBe("http://192.168.1.20:30141");
    expect(s.list()).toHaveLength(1);
    expect(s.get("raspberry")).toBe(n);
    expect(s.remove("raspberry")).toBe(true);
    expect(s.remove("raspberry")).toBe(false);
  });
  test("add rejects duplicate id", () => {
    const s = new MemoryNodeStore();
    s.add({ id: "x", name: "X", url: "http://10.0.0.1:30141" });
    expect(() => s.add({ id: "x", name: "X2", url: "http://10.0.0.2:30141" })).toThrow(/already exists/);
  });
  test("add normalizes url", () => {
    const s = new MemoryNodeStore();
    const n = s.add({ id: "h30141", name: "a", url: "http://10.0.0.5:30141/path?q=1" });
    expect(n.url).toBe("http://10.0.0.5:30141");
  });
  test("update patches fields", () => {
    const s = new MemoryNodeStore();
    s.add({ id: "a", name: "A", url: "http://10.0.0.9:30141" });
    const u = s.update("a", { name: "B", password: "pw" });
    expect(u.name).toBe("B");
    expect(u.password).toBe("pw");
    expect(u.url).toBe("http://10.0.0.9:30141");
  });
  test("update rejects unknown id", () => {
    const s = new MemoryNodeStore();
    expect(() => s.update("nope", { name: "X" })).toThrow(/Unknown node/);
  });
});
