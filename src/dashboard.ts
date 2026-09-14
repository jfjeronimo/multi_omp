// Dashboard UI: the gateway's own page at /.
//
// Same look as omp-web (dark, monospace, #7aa2f7 accent) so the whole
// experience feels like one product. No framework, no build step: a single
// template string + vanilla JS that talks to the gateway control API.
//
// NB: this header used to be a /** ... */ block. tsc 5.9.3 mis-parses that
// specific file-start comment (interface members below become expression
// statements, "Expression expected" at the first `?:`), so it stays //.

import { normalizeTelegramEvents, TELEGRAM_EVENT_KINDS, type TelegramEventKind } from "./telegram";

export interface DashboardNode {
  id: string;
  name: string;
  url: string;
  port?: number;
  hasPassword: boolean;
  note?: string;
  hasTelegram?: boolean;
  /** Per-node allow-list of announced transitions; absent/empty = all. */
  telegramEvents?: TelegramEventKind[];
  status?: { ok: boolean; locked?: boolean; latencyMs?: number; error?: string };
}


/**
 * The Oh-My-Pi mark (omp-web's tab favicon: a pi with an uneven leg,
 * pink→purple→blue gradient), drawn twice side by side — back one
 * offset and translucent — for multi-omp. Inlined so the dashboard and
 * node bar stay self-contained (no external assets); geometry mirrors
 * logo-multi-omp.svg in the repo root. `momo-` prefixed ids so the node
 * bar never clashes with ids on arbitrary omp-web pages it is injected
 * into.
 */
const LOGO_SVG = `<svg class="momo-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 64" aria-hidden="true">
<defs><linearGradient id="momo-pig" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d946ef"/><stop offset="0.5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
<path fill="url(#momo-pig)" opacity=".4" transform="translate(14,-4)" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z"/>
<path fill="url(#momo-pig)" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z"/>
</svg>`;
/**
 * Favicon override for proxied node pages: the gateway's doubled-mark
 * favicon, absolute so it works from any node origin. The gateway serves
 * it at /favicon.svg — a `.svg` path so browsers honor the SVG content
 * (a `.ico` path with SVG bytes is ignored by some, e.g. Firefox).
 *
 * The SPA on the node side (Next.js head management) re-injects its own
 * icon links client-side after hydration, and browsers prefer the links
 * declared last — so a static `<link>` in the server HTML would lose.
 * The injected guardian script removes every foreign icon link and
 * re-inserts ours if it was evicted, re-running on every head mutation
 * (hydration, route changes) until the page is gone.
 */
export function nodeFaviconLink(gwOrigin: string): string {
  return (
    `<link rel="icon" type="image/svg+xml" href="${gwOrigin}/favicon.svg">` +
    `<script>(function () {
  var head = document.head;
  var ours = head.querySelector('link[rel="icon"][href$="/favicon.svg"]');
  function clean() {
    var links = head.querySelectorAll("link");
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (l === ours) continue;
      if ((l.getAttribute("rel") || "").toLowerCase().indexOf("icon") !== -1) l.remove();
    }
    if (ours && !ours.isConnected) head.appendChild(ours);
  }
  clean();
  new MutationObserver(clean).observe(head, { childList: true });
})();</script>`
  );
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
      const tgKinds = normalizeTelegramEvents(n.telegramEvents);
      const tgRestricted = n.hasTelegram && tgKinds.length < TELEGRAM_EVENT_KINDS.length;
      return `
      <tr data-id="${esc(n.id)}" data-telegram-events="${esc(JSON.stringify(n.telegramEvents ?? []))}">
        <td><a class="open" href="${esc(nodeUrl(n))}" target="_blank" rel="noopener"><span class="dot ${dot}"></span>${esc(n.name)}</a></td>
        <td class="url">${esc(n.url)}</td>
        <td><span class="badge">${label}</span>${n.hasTelegram ? ` <span class="badge tg" title="${tgRestricted ? esc("announces: " + tgKinds.join(", ")) : "announces: all"}">tg${tgRestricted ? ` · ${tgKinds.length}/${TELEGRAM_EVENT_KINDS.length}` : ""}</span>` : ""}${n.note ? ` <span class="note">${esc(n.note)}</span>` : ""}</td>
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>multi-omp · dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#14161a; color:#e6e8ea;
         font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  main { max-width:60rem; margin:0 auto; padding:2.5rem 1.5rem; }
  h1 { font-size:1.15rem; margin:0 0 .35rem; display:flex; align-items:center; gap:.5rem; }
  h1 .momo-logo { width:auto; height:1.25rem; flex:none; }
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
  .badge.tg { color:#7aa2f7; border-color:#2a3550; }
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
  .tgev { display:flex; flex-wrap:wrap; gap:.35rem .9rem; margin-top:.3rem; }
  .tgev .ck { display:flex; align-items:center; gap:.3rem; color:#e6e8ea; text-transform:none; font-size:.8rem; letter-spacing:0; }
  .tgev input[type="checkbox"] { accent-color:#7aa2f7; margin:0; }
  @media (max-width: 48rem) { form.add { grid-template-columns:1fr; } }
  .empty { color:#5c6370; padding:1rem 0; }
  .err { color:#f87171; font-size:.8rem; min-height:1.2rem; margin-top:.5rem; }
  footer { margin-top:3rem; color:#3f444d; font-size:.75rem; }
  @media (max-width: 48rem) { form.add { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG}<b>multi-omp</b> · dashboard</h1>
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
    <div><label for="e-tgtok">Telegram bot token (blank = keep)</label><input id="e-tgtok" type="password" placeholder="123456:ABC-…"></div>
    <div><label for="e-tgchat">Telegram chat/channel id (blank = keep)</label><input id="e-tgchat" placeholder="@channel or -100123…"></div>
    <div><label for="e-tgev0">Notify on (checked = announce; all off = announce everything)</label>
      <div class="tgev">
        <label class="ck"><input type="checkbox" id="e-tgev-started" value="started"><span>started</span></label>
        <label class="ck"><input type="checkbox" id="e-tgev-waiting" value="waiting"><span>waiting</span></label>
        <label class="ck"><input type="checkbox" id="e-tgev-finished" value="finished"><span>finished</span></label>
        <label class="ck"><input type="checkbox" id="e-tgev-stopped" value="stopped"><span>stopped</span></label>
      </div>
    </div>
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
  const post = async (url, body, method) => {
    const m = method ?? (body === undefined ? "DELETE" : "POST");
    const res = await fetch(url, {
      method: m,
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
      $("#e-tgtok").value = "";
      $("#e-tgchat").value = "";
      const evs = JSON.parse(tr.dataset.telegramEvents || "[]");
      dlg.dataset.origEvents = JSON.stringify(evs);
      document.querySelectorAll("#edit-form input[type=checkbox][value]").forEach((cb) => {
        cb.checked = evs.includes(cb.value);
      });
      dlg.showModal();
    }
  });
  $("#e-cancel").addEventListener("click", () => dlg.close());
  $("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#edit-err");
    err.textContent = "";
      const evBoxes = [...document.querySelectorAll("#edit-form input[type=checkbox][value]")].filter((cb) => cb.checked).map((cb) => cb.value);
      const evsBefore = JSON.parse(dlg.dataset.origEvents || "[]");
      const evsChanged = evBoxes.length !== evsBefore.length || evBoxes.some((v) => !evsBefore.includes(v));
      await post("/api/nodes/" + encodeURIComponent($("#e-id").value), {
        name: $("#e-name").value,
        url: $("#e-url").value,
        password: $("#e-pass").value || undefined,
        note: $("#e-note").value || undefined,
        telegramToken: $("#e-tgtok").value || undefined,
        telegramEvents: evsChanged ? evBoxes : null,
      }, "PATCH");
      location.reload();
    } catch (e2) { err.textContent = e2.message; }
  });
})();
</script>
</body>
</html>`;
}

/**
 * Overlay bar injected into every omp-web HTML document served through a
 * node port. Lets the user switch between the gateway's nodes from inside a
 * node, and shows the current node's status + live metrics (jobs running,
 * sessions waiting on the user). Self-contained (inline style + script, no
 * external assets) and reuses omp-web's visual tokens so it reads as part of
 * the app.
 *
 * `gwOrigin` is the control-plane origin (e.g. `http://10.0.0.5:30140`) the
 * bar fetches cross-origin (CORS is enabled on the /api routes). The gateway
 * serves each node at the root of its own port on the same host, so the bar
 * only needs the gateway origin plus the selected node's port to build the
 * destination URL. `currentId` marks which node this page belongs to.
 */
export function renderNodeBar(gwOrigin: string, currentId: string): string {
  return `
<style id="momo-bar-css">
#momo-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:.6rem;
  padding:.3rem .7rem;background:#14161af2;border-bottom:1px solid #23272e;
  font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6e8ea}
#momo-bar .momo-title{color:#7aa2f7;font-weight:600;letter-spacing:.02em;display:inline-flex;align-items:center;gap:.4rem}
#momo-bar .momo-logo{width:auto;height:.85rem;flex:none}
#momo-bar select{background:#1a1d22;color:#e6e8ea;border:1px solid #2a2e35;border-radius:5px;
  font:inherit;padding:.15rem .35rem;max-width:16rem}
#momo-bar select:focus{outline:none;border-color:#7aa2f7}
#momo-bar .momo-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
#momo-bar .momo-dot.ok{background:#4ade80}
#momo-bar .momo-dot.lock{background:#facc15}
#momo-bar .momo-dot.down{background:#f87171}
#momo-bar .momo-dot.wait{background:#f472b6}
#momo-bar .momo-metrics{color:#a8adb4;margin-left:auto;display:flex;gap:.9rem;white-space:nowrap}
#momo-bar .momo-metrics b{color:#e6e8ea;font-weight:600}
#momo-bar .momo-wait{color:#f472b6}
#momo-bar .momo-x{color:#5c6370;cursor:pointer;border:none;background:none;font:inherit;padding:0 .1rem}
#momo-bar .momo-x:hover{color:#e6e8ea}
#momo-restore{position:fixed;top:0;right:0;z-index:2147483647;cursor:pointer;
  font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7aa2f7;
  background:#14161af2;border:1px solid #23272e;border-top:none;border-right:none;
  border-radius:0 0 0 6px;padding:.3rem .55rem;opacity:.55}
body.momo-bar-on{padding-top:2.1rem!important}
body.momo-bar-hidden{padding-top:0!important}
</style>
<div id="momo-bar">
  <span class="momo-dot down" id="momo-dot"></span>
  <span class="momo-title">${LOGO_SVG}multi-omp</span>
  <select id="momo-select" aria-label="Switch node"></select>
  <span class="momo-metrics" id="momo-metrics"></span>
  <button class="momo-x" id="momo-x" title="Hide bar (this device)">–</button>
</div>
<div id="momo-restore" style="display:none" title="Show multi-omp bar">▤ multi-omp</div>
<script>
(function () {
  var GW = ${JSON.stringify(gwOrigin)};
  var ME = ${JSON.stringify(currentId)};
  var bar = document.getElementById("momo-bar");
  var sel = document.getElementById("momo-select");
  var dot = document.getElementById("momo-dot");
  var met = document.getElementById("momo-metrics");
  var restore = document.getElementById("momo-restore");
  function hideBar() {
    localStorage.setItem("momo-bar-hidden", "1");
    bar.style.display = "none";
    document.body.classList.remove("momo-bar-on");
    document.body.classList.add("momo-bar-hidden");
    restore.style.display = "block";
  }
  function showBar() {
    localStorage.removeItem("momo-bar-hidden");
    bar.style.display = "";
    document.body.classList.remove("momo-bar-hidden");
    document.body.classList.add("momo-bar-on");
    restore.style.display = "none";
  }
  if (localStorage.getItem("momo-bar-hidden") === "1") hideBar();
  else document.body.classList.add("momo-bar-on");
  document.getElementById("momo-x").addEventListener("click", hideBar);
  restore.addEventListener("click", showBar);
  function refresh() {
    // /api/nodes has no per-node status; /api/health returns one per id.
    // Merge both so the dot + "(down)"/"(locked)" labels reflect reality.
    return Promise.all([
      fetch(GW + "/api/nodes").then(function (r) { return r.json(); }),
      fetch(GW + "/api/health").then(function (r) { return r.json(); }).catch(function () { return { statuses: [] }; }),
    ]).then(function (res) {
      var nodes = (res[0] && res[0].nodes) || [];
      var byStatus = {};
      var list = (res[1] && res[1].statuses) || [];
      for (var h = 0; h < list.length; h++) byStatus[list[h].id] = list[h].status;
      sel.innerHTML = "";
      var me = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.status = byStatus[n.id];
        var opt = document.createElement("option");
        opt.value = n.id;
        var label = n.name;
        if (n.status && !n.status.ok) label += " (down)";
        else if (n.status && n.status.locked) label += " (locked)";
        if (n.id === ME) label = "▸ " + label;
        opt.textContent = label;
        if (n.id === ME) { me = n; opt.selected = true; }
        sel.appendChild(opt);
      }
      var st = me ? me.status : null;
      dot.className = "momo-dot " + (st ? (st.ok ? (st.locked ? "lock" : "ok") : "down") : "down");
      fetch(GW + "/api/nodes/" + encodeURIComponent(ME) + "/metrics")
        .then(function (r) { return r.json(); })
        .then(function (m) {
          var html = "";
          if (typeof m.running === "number" && m.running > 0) html += '<span>jobs <b>' + m.running + '</b></span>';
          if (typeof m.waiting === "number" && m.waiting > 0) {
            html += '<span class="momo-wait">awaiting you</span>';
            dot.className = "momo-dot wait";
          }
          met.innerHTML = html;
        })
        .catch(function () { met.innerHTML = ""; });
    }).catch(function () {
      dot.className = "momo-dot down";
      met.innerHTML = "";
    });
  }
  sel.addEventListener("change", function () {
    var id = sel.value;
    fetch(GW + "/api/nodes/" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var port = d.node && d.node.port;
        if (port) location.href = GW.replace(/:[0-9]+$/, ":" + port) + "/";
      })
      .catch(function () {});
  });
  refresh();
  setInterval(refresh, 15000);
})();
</script>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
