// The cockpit (HOST_DESIGN.md section 6), first form: pages the daemon serves. Everything shown is
// a daemon route an agent could call, and everything a button does is a POST to one - the page
// holds no truth of its own. Polling for the slow tables (projects, sessions, Blockbench), SSE for
// the two things that move (the change feed, a run's output).
"use strict";

// A page error is shown, not swallowed: a cockpit that goes quiet is worse than one that says why.
window.addEventListener("error", (e) => toast(`page error: ${e.message} (${(e.filename ?? "").split("/").pop()}:${e.lineno})`, "bad"));
window.addEventListener("unhandledrejection", (e) => toast(`page error: ${e.reason?.message ?? e.reason}`, "bad"));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const PROFILES = ["modding", "art", "entity", "authoring", "screens", "inspect", "standard", "full", "play", "survey", "survival"];

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.title = "click to dismiss";
  el.onclick = () => el.remove();
  $("#toasts").append(el);
  // A page error stays until dismissed; everything else fades.
  if (!/^page error/.test(text)) setTimeout(() => el.remove(), kind === "bad" ? 9000 : 4000);
}

const fmt = {
  ago(iso) {
    if (!iso) return "–";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
  clock(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "–"; },
  dur(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  },
  uptime(s) { return s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; },
};

// --- tabs -----------------------------------------------------------------------------------------
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
  try { localStorage.setItem("mmcp.tab", b.dataset.tab); } catch { /* fine */ }
});
try { const t = localStorage.getItem("mmcp.tab"); if (t) $(`#tabs button[data-tab="${t}"]`)?.click(); } catch { /* fine */ }

// --- status ---------------------------------------------------------------------------------------
async function pollStatus() {
  try {
    const s = await api("GET", "/status");
    $("#daemon-dot").className = "dot up";
    $("#daemon-line").textContent = `${s.version} · :${s.port} · up ${fmt.uptime(s.uptime_s)} · disk feed ${s.watching ? "on" : "OFF"}`
      + `${s.supervisor?.available ? "" : " · no rebuild script (run/stop refused)"}`;
    $("#count-sessions").textContent = s.sessions || "";
    $("#count-bb").textContent = s.blockbench || "";
  } catch (e) {
    $("#daemon-dot").className = "dot down";
    $("#daemon-line").textContent = `daemon unreachable (${e.message})`;
  }
}

// --- projects -------------------------------------------------------------------------------------
const cards = new Map(); // name -> {el, run: {id, es}, lastShown}

function classify(line) {
  if (/error|exception|FAILED|refus|timed out|SPAWN ERROR/i.test(line)) return "err";
  if (/bridge is up|build OK|BUILD SUCCESSFUL|game stopped/.test(line)) return "ok";
  if (/\[rebuild\]/.test(line)) return "warn";
  return "";
}

function appendLog(pre, line) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  const span = document.createElement("span");
  span.className = classify(line);
  span.textContent = `${line}\n`;
  pre.append(span);
  while (pre.childNodes.length > 2500) pre.firstChild.remove();
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function showRun(card, run) {
  const box = $(".run", card.el);
  box.hidden = false;
  const phase = $(".phase", box);
  phase.textContent = run.running ? run.phase : (run.outcome ?? run.phase);
  phase.className = `pill phase ${run.running ? `${run.phase} running` : (run.exit === 0 ? (run.kind === "stop" ? "stopped" : "up") : "failed")}`;
  $(".run-line", box).textContent = `${run.id} · ${run.kind} ${run.target}${run.rebuild ? " (rebuild)" : ""}${run.takeover ? " (takeover)" : ""} · ${run.running ? `${fmt.dur(run.elapsed_ms)} so far` : `${fmt.dur(run.elapsed_ms)}, exit ${run.exit}`} · started ${fmt.clock(run.started_at)}`;
}

function followRun(card, run) {
  if (card.run?.id === run.id) return;
  card.run?.es?.close();
  const pre = $(".runlog", card.el);
  pre.textContent = "";
  const es = new EventSource(`/projects/${encodeURIComponent(card.name)}/log?run=${encodeURIComponent(run.id)}`);
  card.run = { id: run.id, es };
  es.addEventListener("run", (e) => showRun(card, JSON.parse(e.data)));
  es.addEventListener("line", (e) => appendLog(pre, JSON.parse(e.data)));
  es.addEventListener("exit", (e) => {
    const r = JSON.parse(e.data);
    showRun(card, r);
    es.close();
    card.run = { id: run.id, es: null, done: true };
    toast(`${card.name}: ${r.kind} ${r.outcome}`, r.exit === 0 ? "ok" : "bad");
    pollProjects();
  });
  es.onerror = () => { /* the browser retries; a finished run closes above */ };
}

function bindCard(card) {
  const el = card.el;
  const opts = () => ({
    target: $(".target", el).value, takeover: $(".takeover", el).checked, fabricapi: $(".fabricapi", el).checked,
    ui: $(".uidoc", el).value.trim() || undefined,
  });
  const act = async (what, body) => {
    const buttons = $$("button", el);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const r = await api("POST", `/projects/${encodeURIComponent(card.name)}/${what}`, body);
      toast(`${card.name}: ${r.run.kind} started (${r.run.id})`, "ok");
      followRun(card, r.run);
      showRun(card, r.run);
      pollProjects();
    } catch (e) {
      toast(`${card.name}: ${e.message}`, "bad");
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  $(".launch", el).onclick = () => act("run", { ...opts(), rebuild: false });
  $(".rebuild", el).onclick = () => act("run", { ...opts(), rebuild: true });
  $(".stop", el).onclick = () => act("stop", { takeover: $(".takeover", el).checked });
  $(".toggle-log", el).onclick = (e) => { const pre = $(".runlog", el); pre.hidden = !pre.hidden; e.target.textContent = pre.hidden ? "show" : "hide"; };
  $(".url", el).onclick = async (e) => {
    try { await navigator.clipboard.writeText(e.target.textContent); toast("URL copied"); } catch { toast("copy refused by the browser", "bad"); }
  };
  $(".latest", el).onclick = async () => {
    const box = $(".latest-box", el);
    try {
      const r = await api("GET", `/projects/${encodeURIComponent(card.name)}/latest?lines=300`);
      const pre = $(".latestlog", box);
      pre.textContent = "";
      if (!r.exists) pre.textContent = `${r.file}: ${r.error}`;
      else for (const line of r.lines) appendLog(pre, line);
      $(".latest-line", box).textContent = r.exists ? `${r.file} · ${(r.size / 1024).toFixed(0)} KB · modified ${fmt.ago(r.modified_at)} · last ${r.lines.length} lines` : r.file;
      box.hidden = false;
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { toast(e.message, "bad"); }
  };
  $(".close-latest", el).onclick = () => { $(".latest-box", el).hidden = true; };
}

function renderProject(p) {
  let card = cards.get(p.name);
  if (!card) {
    const el = $("#project-card").content.firstElementChild.cloneNode(true);
    card = { name: p.name, el, run: null };
    cards.set(p.name, card);
    $("#projects").append(el);
    $(".pname", el).textContent = p.name;
    bindCard(card);
  }
  const el = card.el;
  const state = $(".state", el);
  state.textContent = p.state + (p.run?.kind === "run" && p.state !== "building" ? ` · ${p.run.phase}` : "");
  state.className = `pill state ${p.state}`;
  $(".port", el).textContent = `:${p.port}`;
  $(".loader", el).textContent = [p.loader, p.mc].filter(Boolean).join(" ") || "";
  const root = $(".root", el);
  root.textContent = p.root; root.title = `${p.root}  (game dir ${p.gameDir})`;
  $(".url", el).textContent = p.url;
  const sess = $(".psessions", el);
  sess.innerHTML = "";
  if (!p.sessions.length) sess.textContent = "none";
  for (const id of p.sessions) { const c = document.createElement("span"); c.className = "chip"; c.textContent = id; sess.append(c, " "); }
  const w = p.watch;
  $(".watch", el).textContent = w ? `${w.files} files · ${w.flushes} flush${w.flushes === 1 ? "" : "es"}${w.pending ? ` · ${w.pending} pending` : ""}${w.last_flush_at ? ` · last ${fmt.ago(w.last_flush_at)}` : ""}` : "off";
  const gf = $(".game-fact", el);
  if (p.game) {
    gf.hidden = false;
    $(".game", el).textContent = `${p.game.env ?? "?"} ${p.game.loader ?? ""} · ${p.game.client ? "client" : "server"}${p.game.instance ? ` · instance ${p.game.instance}` : ""}`;
  } else gf.hidden = true;
  const running = p.run;
  $(".stop", el).disabled = !!running && !$(".takeover", el).checked;
  if (running) followRun(card, running), showRun(card, running);
  else if (p.last_run && !card.run) {
    // Nothing in flight: show the last run's tail once, collapsed to its verdict.
    card.run = { id: p.last_run.id, es: null, done: true };
    showRun(card, p.last_run);
    api("GET", `/projects/${encodeURIComponent(p.name)}/log?run=${p.last_run.id}`).then((r) => {
      const pre = $(".runlog", el);
      pre.textContent = "";
      for (const line of r.lines.slice(-60)) appendLog(pre, line);
      pre.scrollTop = pre.scrollHeight;
    }).catch(() => {});
  }
}

async function pollProjects() {
  try {
    const { projects } = await api("GET", "/projects");
    $("#projects-empty").hidden = projects.length > 0;
    const seen = new Set();
    for (const p of projects) { renderProject(p); seen.add(p.name); }
    for (const [name, card] of cards) if (!seen.has(name)) { card.run?.es?.close(); card.el.remove(); cards.delete(name); }
    const sel = $("#changes-project");
    const have = new Set($$("option", sel).map((o) => o.value));
    for (const p of projects) if (!have.has(p.name)) { const o = document.createElement("option"); o.value = o.textContent = p.name; sel.append(o); }
    if (projects[0]) $("#sessions-url").textContent = projects[0].url;
  } catch (e) { if (!/fetch/i.test(e.message)) toast(`page error in projects: ${e.message}`, "bad"); }
}

// --- sessions -------------------------------------------------------------------------------------
async function pollSessions() {
  try {
    const { sessions } = await api("GET", "/sessions");
    const tbody = $("#sessions tbody");
    $("#sessions-empty").hidden = sessions.length > 0;
    const rows = new Map($$("tr", tbody).map((tr) => [tr.dataset.id, tr]));
    for (const s of sessions) {
      let tr = rows.get(s.id);
      if (!tr) {
        tr = document.createElement("tr");
        tr.dataset.id = s.id;
        tr.innerHTML = `<td class="mono"></td><td></td><td></td><td><select class="profile"></select></td><td class="num"></td><td class="num"></td><td></td><td class="num"></td><td></td>
          <td><button class="small log">log</button> <button class="small danger kick">kick</button></td>`;
        const sel = $(".profile", tr);
        for (const p of PROFILES) { const o = document.createElement("option"); o.value = o.textContent = p; sel.append(o); }
        sel.onchange = async () => {
          try { const r = await api("POST", `/sessions/${s.id}/profile`, { profile: sel.value }); toast(`${s.id}: profile ${sel.value} (${r.report?.tools ?? "?"} tools)`, "ok"); pollSessions(); }
          catch (e) { toast(e.message, "bad"); }
        };
        $(".kick", tr).onclick = async () => { try { await api("DELETE", `/sessions/${s.id}`); toast(`${s.id} closed`); pollSessions(); } catch (e) { toast(e.message, "bad"); } };
        $(".log", tr).onclick = async () => {
          try {
            const r = await api("GET", `/sessions/${s.id}/log`);
            const pre = $("#session-log");
            pre.hidden = false; pre.textContent = `# ${s.id} shim stderr (last ${r.lines.length} lines)\n`;
            for (const line of r.lines) appendLog(pre, line);
            pre.scrollTop = pre.scrollHeight;
          } catch (e) { toast(e.message, "bad"); }
        };
        tbody.append(tr);
      }
      const td = $$("td", tr);
      td[0].textContent = s.id;
      td[1].textContent = s.project;
      td[2].textContent = s.client ? `${s.client.name ?? "?"} ${s.client.version ?? ""}` : "–";
      const sel = $(".profile", tr);
      if (s.profile && !PROFILES.includes(s.profile)) { const o = document.createElement("option"); o.value = o.textContent = s.profile; sel.append(o); }
      if (document.activeElement !== sel) sel.value = s.profile ?? "";
      td[4].textContent = s.tools ?? "–";
      td[5].textContent = s.calls ?? 0;
      td[6].textContent = s.last_call ? `${s.last_call.tool ?? s.last_call.name ?? JSON.stringify(s.last_call).slice(0, 40)} · ${fmt.ago(s.last_call.at ?? s.last_seen_at)}` : `– · seen ${fmt.ago(s.last_seen_at)}`;
      td[7].textContent = s.streams;
      td[8].textContent = s.blockbench ? s.blockbench.replace(/^http:\/\//, "") : "–";
      rows.delete(s.id);
    }
    for (const tr of rows.values()) tr.remove();
  } catch { /* status line */ }
}

// --- changes --------------------------------------------------------------------------------------
const changes = []; // newest first
const QUIET = new Set(["refused", "none"]);
function changeVisible(row) {
  const project = $("#changes-project").value;
  if (project && row.project !== project) return false;
  if ($("#changes-quiet").checked && QUIET.has(row.live?.result)) return false;
  return true;
}
function renderChanges() {
  const tbody = $("#changes tbody");
  tbody.innerHTML = "";
  let shown = 0;
  for (const row of changes) {
    if (!changeVisible(row)) continue;
    shown++;
    const tr = document.createElement("tr");
    tr.className = "clickable" + (row.fresh ? " fresh" : "");
    const live = row.live ?? {};
    tr.innerHTML = `<td class="mono" title="${row.at}">${fmt.clock(row.at)}</td><td>${row.project}</td><td>${row.op}</td><td><span class="path"></span></td><td>${row.feed}</td><td class="mono">${live.act ?? ""}</td><td><span class="pill ${live.result ?? "none"}">${live.result ?? ""}</span></td><td class="num">${live.ms ?? ""}</td><td class="small"></td>`;
    $(".path", tr).textContent = row.path;
    $("td:last-child", tr).textContent = live.error ?? live.note ?? (row.event_id != null ? `event ${row.event_id}` : "");
    tr.onclick = () => {
      const next = tr.nextElementSibling;
      if (next?.classList.contains("hunk-row")) { next.remove(); return; }
      const hr = document.createElement("tr");
      hr.className = "hunk-row";
      hr.innerHTML = `<td class="hunk" colspan="9"><pre></pre></td>`;
      $("pre", hr).textContent = row.hunk || "(no hunk)";
      tr.after(hr);
    };
    tbody.append(tr);
    row.fresh = false;
  }
  const empty = $("#changes-empty");
  empty.hidden = shown > 0;
  if (shown === 0 && changes.length) empty.textContent = `${changes.length} row${changes.length === 1 ? "" : "s"}, all refused or none - hidden by the filter above.`;
  $("#count-changes").textContent = changes.length || "";
}
function openChanges() {
  const es = new EventSource("/changes");
  es.addEventListener("edit", (e) => {
    const row = JSON.parse(e.data);
    if (changes.some((r) => r.id === row.id)) return;
    row.fresh = true;
    changes.unshift(row);
    while (changes.length > 500) changes.pop();
    renderChanges();
  });
  es.onerror = () => { /* the browser reconnects with Last-Event-ID; the ring replays what was missed */ };
}
$("#changes-project").onchange = renderChanges;
$("#changes-quiet").onchange = renderChanges;

// --- blockbench -----------------------------------------------------------------------------------
async function pollBlockbench() {
  try {
    const r = await api("GET", "/blockbench");
    $("#bb-line").textContent = `${r.exe ?? "Blockbench.exe not configured"} · template ${r.template}`;
    const tbody = $("#blockbench tbody");
    tbody.innerHTML = "";
    $("#bb-empty").hidden = r.instances.length > 0;
    for (const i of r.instances) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono">${i.session}</td><td>${i.project ?? ""}</td><td><span class="pill ${i.state}">${i.state}${i.orphaned_at ? " (orphaned)" : ""}</span></td><td class="mono">${i.port ?? "–"}</td><td class="mono">${i.pid ?? "–"}</td><td class="num">${i.calls ?? 0}</td><td>${i.last_call ? (i.last_call.tool ?? i.last_call.path ?? "") : "–"}</td><td>${fmt.ago(i.started_at)}</td><td><button class="small danger">kill</button></td>`;
      $("button", tr).onclick = async () => {
        if (!confirm(`Kill the Blockbench instance of ${i.session}? Unsaved work in it is lost.`)) return;
        try { await api("DELETE", `/blockbench/${i.session}?force=1`); toast(`${i.session}: Blockbench killed`); pollBlockbench(); } catch (e) { toast(e.message, "bad"); }
      };
      tbody.append(tr);
    }
  } catch { /* status line */ }
}
$("#bb-template").onclick = async () => {
  try { const r = await api("POST", "/blockbench/template"); toast(`template re-seeded at ${r.template ?? r.path ?? "?"}`, "ok"); pollBlockbench(); } catch (e) { toast(e.message, "bad"); }
};

// --- the loop -------------------------------------------------------------------------------------
function tick() {
  if (document.visibilityState !== "visible") return;
  pollStatus();
  pollProjects();
  pollSessions();
  pollBlockbench();
}
tick();
setInterval(tick, 3000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
openChanges();
