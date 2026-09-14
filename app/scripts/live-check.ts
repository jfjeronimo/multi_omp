// Live-check harness: two mock upstreams + real gateway, no notifier noise.
import { startMockUpstream } from "../tests/helpers/mock-upstream";
import { FileNodeStore } from "../src/store";
import { createGateway } from "../src/gateway";

import { rmSync, mkdirSync } from "node:fs";
const home = "/tmp/momo-live-check";
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const store = new FileNodeStore(`${home}/nodes.json`);
await store.load();


const a = await startMockUpstream();
const b = await startMockUpstream({ locked: true });

if (store.list().length === 0) {
  store.add({ id: "alpha", name: "alpha", url: a.url, username: "omp" });
  store.add({ id: "bravo", name: "bravo", url: b.url, username: "omp", password: "mock-pass" });
}
const gw = createGateway({ store, port: 31140, hostname: "127.0.0.1", notifierIntervalMs: 0 });
console.log(`READY gw=${gw.server.port} alpha=${gw.nodes()[0].server.port} bravo=${gw.nodes()[1].server.port}`);
for (const n of gw.nodes()) console.log(`NODE ${n.id} port=${n.server.port}`);

process.on("SIGTERM", () => { gw.stop(); process.exit(0); });
await new Promise(() => {});
