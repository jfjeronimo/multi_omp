/**
 * Dashboard UI: the gateway's own page at /.
 *
 * Same look as omp-web (dark, monospace, #7aa2f7 accent) so the whole
 * experience feels like one product. No framework, no build step: a single
 * template string + vanilla JS that talks to the gateway control API.
 */

export interface DashboardNode {
  id: string;
  name: string;
  url: string;
  port?: number;
  hasPassword: boolean;
  note?: string;
  status?: { ok: boolean; locked?: boolean; latencyMs?: number; error?: string };
}

/**
 * Render the dashboard. `host`/`gwPort` describe the gateway itself, used
 * to build the per-node Open URLs (each node lives at the root of its own
 * local port on this host).
 */
export function renderDashboard(nodes: DashboardNode[], host: string, gwPort: number, version: string): string {
  const nodeUrl = (n: DashboardNode): string =>
    typeof n.port === "number" ? `http://${host}:${n.port}/` : "#";
  const rows = nodes
    .map((n) => {
      const s = n.status;
      const dot = s?.ok ? (s.locked ? "lock" : "ok") : "down";
      const label = s?.ok
        ? s.locked
          ? "locked"
          : `up · ${s.latencyMs ?? "?"} ms`
        : s?.error ?? "down";
      return `
      <tr data-id="${esc(n.id)}">
        <td><a class="open" href="${esc(nodeUrl(n))}" target="_blank" rel="noopener"><span class="dot ${dot}"></span>${esc(n.name)}</a></td>
        <td class="url">${esc(n.url)}</td>
        <td class="local">${esc(nodeUrl(n))}</td>
        <td><span class="badge">${label}</span>${n.note ? ` <span class="note">${esc(n.note)}</span>` : ""}</td>
        <td class="actions">
          <button data-act="edit" data-id="${esc(n.id)}">edit</button>
          <button data-act="remove" data-id="${esc(n.id)}">remove</button>
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>multi-omp · dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#14161a; color:#e6e8ea;
         font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  main { max-width:60rem; margin:0 auto; padding:2.5rem 1.5rem; }
  h1 { font-size:1.15rem; margin:0 0 .35rem; }
  h1 b { color:#7aa2f7; }
  .sub { color:#a8adb4; margin:0 0 1.75rem; font-size:.85rem; }
  h2 { font-size:.95rem; margin:2rem 0 .75rem; color:#a8adb4; text-transform:uppercase; letter-spacing:.06em; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:.55rem .6rem; border-bottom:1px solid #23272e; vertical-align:middle; }
  th { color:#5c6370; font-weight:500; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
  a.open { color:#e6e8ea; text-decoration:none; font-weight:600; }
  a.open:hover { color:#7aa2f7; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:.5rem; vertical-align:baseline; }
  .dot.ok { background:#4ade80; }
  .dot.lock { background:#facc15; }
  .dot.down { background:#f87171; }
  .url { color:#5c6370; }
  .local { color:#5c6370; font-size:.78rem; }
  .badge { font-size:.75rem; padding:.1rem .45rem; border-radius:4px; background:#1d2127; border:1px solid #2a2e35; }
  .note { color:#5c6370; font-size:.78rem; }
  button { background:#1a1d22; color:#e6e8ea; border:1px solid #2a2e35; border-radius:6px;
           padding:.25rem .6rem; font:inherit; font-size:.8rem; cursor:pointer; }
  button:hover { border-color:#7aa2f7; color:#7aa2f7; }
  .actions { white-space:nowrap; }
  .actions button + button { margin-left:.4rem; }
  form.add { display:grid; grid-template-columns: 1fr 1fr 1.4fr auto; gap:.6rem; align-items:end; }
  form.add label { display:block; color:#5c6370; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.3rem; }
  input, textarea { width:100%; background:#1a1d22; color:#e6e8ea; border:1px solid #2a2e35;
                    border-radius:6px; padding:.45rem .6rem; font:inherit; }
  input:focus, textarea:focus { outline:none; border-color:#7aa2f7; }
  .add .go { padding:.5rem 1rem; }
  .hidden { display:none; }
  dialog { background:#1a1d22; color:#e6e8ea; border:1px solid #2a2e35; border-radius:10px;
           padding:1.25rem 1.4rem; width:min(30rem, 90vw); font:inherit; }
  dialog::backdrop { background:rgba(0,0,0,.55); }
  dialog h3 { margin:0 0 1rem; font-size:.95rem; }
  dialog form { display:grid; gap:.7rem; }
  dialog label { color:#5c6370; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; }
  dialog .row { display:flex; gap:.6rem; justify-content:flex-end; margin-top:.5rem; }
  .empty { color:#5c6370; padding:1rem 0; }
  .err { color:#f87171; font-size:.8rem; min-height:1.2rem; margin-top:.5rem; }
  footer { margin-top:3rem; color:#3f444d; font-size:.75rem; }
  @media (max-width: 48rem) { form.add { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <h1><b>multi-omp</b> · dashboard</h1>
  <p class="sub">One gateway for all your omp-web nodes — open a node to use omp-web unchanged.</p>

  <h2>Nodes</h2>
  ${nodes.length === 0
    ? '<p class="empty">No nodes yet — add one below.</p>'
    : `<table>
      <thead><tr><th>Node</th><th>Origin</th><th>Local</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}

  <h2>Add node</h2>
  <form class="add" id="add-form">
    <div><label for="f-name">Name</label><input id="f-name" required placeholder="raspberry"></div>
    <div><label for="f-url">URL</label><input id="f-url" required placeholder="http://192.168.1.20:30141"></div>
    <div><label for="f-pass">Password (if node is locked)</label><input id="f-pass" type="password" placeholder="(optional)"></div>
    <div><button class="go" type="submit">add</button></div>
  </form>
  <div class="err" id="add-err"></div>

  <footer>multi-omp ${esc(version)} — nodes and credentials stay on this machine (nodes.json, mode 0600).</footer>
</main>

<dialog id="edit-dlg">
  <h3>Edit node</h3>
  <form id="edit-form">
    <input type="hidden" id="e-id">
    <div><label for="e-name">Name</label><input id="e-name" required></div>
    <div><label for="e-url">URL</label><input id="e-url" required></div>
    <div><label for="e-pass">New password (leave blank to keep)</label><input id="e-pass" type="password"></div>
    <div><label for="e-note">Note</label><input id="e-note"></div>
    <div class="row">
      <button type="button" id="e-cancel">cancel</button>
      <button type="submit">save</button>
    </div>
  </form>
  <div class="err" id="edit-err"></div>
</dialog>

<script>
(function () {
  const $ = (s) => document.querySelector(s);
  const post = async (url, body) => {
    const res = await fetch(url, {
      method: body === undefined ? "DELETE" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  };

  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#add-err");
    err.textContent = "";
    try {
      await post("/api/nodes", {
        name: $("#f-name").value,
        url: $("#f-url").value,
        password: $("#f-pass").value || undefined,
      });
      location.reload();
    } catch (e2) { err.textContent = e2.message; }
  });

  const dlg = $("#edit-dlg");
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "remove") {
      if (!confirm("Remove this node?")) return;
      post("/api/nodes/" + encodeURIComponent(id)).then(() => location.reload());
    } else {
      const tr = btn.closest("tr");
      $("#e-id").value = id;
      $("#e-name").value = tr.querySelector("a.open").textContent.trim();
      $("#e-url").value = tr.querySelector(".url").textContent.trim();
      $("#e-note").value = tr.querySelector(".note") ? tr.querySelector(".note").textContent : "";
      $("#e-pass").value = "";
      dlg.showModal();
    }
  });
  $("#e-cancel").addEventListener("click", () => dlg.close());
  $("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#edit-err");
    err.textContent = "";
    try {
      await post("/api/nodes/" + encodeURIComponent($("#e-id").value), {
        name: $("#e-name").value,
        url: $("#e-url").value,
        password: $("#e-pass").value || undefined,
        note: $("#e-note").value || undefined,
      });
      location.reload();
    } catch (e2) { err.textContent = e2.message; }
  });
})();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
