import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkNode } from "../src/upstream";
import { startMockUpstream, type MockUpstream } from "./helpers/mock-upstream";

describe("checkNode", () => {
  let mock: MockUpstream;
  const nodeNoPass = { id: "a", name: "A", url: "" };

  beforeAll(async () => {
    mock = await startMockUpstream({ locked: false });
  });
  afterAll(() => mock.server.stop(true));

  test("200 -> ok", async () => {
    const s = await checkNode({ ...nodeNoPass, url: mock.url });
    expect(s.ok).toBe(true);
    expect(s.locked).toBeUndefined();
    expect(s.error).toBeUndefined();
    expect(s.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("401 -> locked", async () => {
    mock.setLocked(true);
    try {
      const s = await checkNode({ ...nodeNoPass, url: mock.url });
      expect(s.ok).toBe(true);
      expect(s.locked).toBe(true);
    } finally {
      mock.setLocked(false);
    }
  });

  test("403 -> host not allowed", async () => {
    const strict = await startMockUpstream({ rejectHost: () => true });
    try {
      const s = await checkNode({ id: "b", name: "B", url: strict.url });
      expect(s.ok).toBe(false);
      expect(s.error).toMatch(/forbidden/i);
    } finally {
      strict.server.stop(true);
    }
  });

  test("connection refused -> down", async () => {
    const s = await checkNode({ ...nodeNoPass, url: "http://127.0.0.1:1" });
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });
  test("timeout -> down with timeout error", async () => {
    const s = await checkNode({ ...nodeNoPass, url: "http://10.255.255.1:30141" }, 300);
    expect(s.ok).toBe(false);
    expect(s.error).toBe("timeout");
  });

  test("auth passed through when password set", async () => {
    mock.setLocked(true);
    try {
      const s = await checkNode({ id: "a", name: "A", url: mock.url, password: "mock-pass" });
      expect(s.ok).toBe(true);
      expect(s.locked).toBeUndefined();
      const last = mock.requests[mock.requests.length - 1];
      expect(last.auth).toBe(`Basic ${Buffer.from("omp:mock-pass").toString("base64")}`);
    } finally {
      mock.setLocked(false);
    }
  });
});
