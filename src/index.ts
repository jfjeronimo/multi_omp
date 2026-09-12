/**
 * multi-omp entrypoint: dashboard + control plane on :30140 by default, plus
 * one transparent reverse-proxy listener per node on its own local port.
 *
 *   PORT / MULTI_OMP_PORT        gateway port (default 30140)
 *   HOSTNAME / MULTI_OMP_HOST    gateway bind (default 127.0.0.1)
 *   MULTI_OMP_HOME               data dir (default ~/.omp/multi-omp)
 *   MULTI_OMP_NOTIFIER_MS        Telegram notifier poll ms (default 10000; 0 = off)
 */

import { FileNodeStore } from "./store";
import { createGateway } from "./gateway";

const home = process.env.MULTI_OMP_HOME ?? `${process.env.HOME}/.omp/multi-omp`;
const store = new FileNodeStore(`${home}/nodes.json`);
await store.load();
const hostname = process.env.MULTI_OMP_HOST ?? process.env.HOSTNAME_BIND ?? "127.0.0.1";
const gateway = createGateway({
  store,
  port: Number(process.env.MULTI_OMP_PORT ?? process.env.PORT ?? 30140),
  hostname,
  notifierIntervalMs: Number(process.env.MULTI_OMP_NOTIFIER_MS || 10_000),
});

console.log(`multi-omp dashboard on http://${gateway.server.hostname}:${gateway.server.port}`);
for (const n of gateway.nodes()) {
  console.log(`  node ${n.id} -> http://${hostname}:${n.server.port}/`);
}
if (gateway.nodes().length === 0) {
  console.log(`node store: ${home}/nodes.json (0 nodes — add one from the dashboard)`);
} else {
  console.log(`node store: ${home}/nodes.json`);
}
