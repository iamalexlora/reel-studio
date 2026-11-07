/* Reel Studio v2 — interfaz */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`; };
const num = (x, d = 2) => (+x).toFixed(d).replace(".", ",");
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  meta: null, projects: [], brands: [], P: null, plan: null, groups: [], outT: 0, playing: false,
  sel: null, anchor: null, history: [], dirty: false, saving: false, saveTimer: null,
  selClip: null, selBroll: null, selJunction: null, tab: "t-texto", useRender: false,
  exp: null, cur: null, cardClock: null,
};

/* ---------------------------------------------------------------- base */
async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = raw; opt.headers["Content-Type"] = "application/octet-stream"; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  let j = null; try { j = await r.json(); } catch (_) {}
  if (r.status === 409 && j && j.conflict) return { __conflict: true, ...j };
  if (!r.ok) throw new Error((j && j.error) || `Error ${r.status}`);
  return j;
}
function toast(msg, ms = 2800) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function upload(url, file, onProg) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProg && onProg(e.loaded / e.total);
    x.onload = () => { let j; try { j = JSON.parse(x.responseText); } catch (_) { j = {}; } x.status === 200 ? res(j) : rej(new Error(j.error || "No se pudo subir")); };
    x.onerror = () => rej(new Error("Se cortó la subida"));
    x.send(file);
  });
}

/* ---------------------------------------------------------------- tema */
const mq = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme(t) {
  const root = document.documentElement;
  root.dataset.theme = t;
  root.classList.toggle("sys-light", t === "auto" && mq.matches);
  $$("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === t));
  try { localStorage.setItem("rs-theme", t); } catch (_) {}
}
mq.addEventListener("change", () => applyTheme(document.documentElement.dataset.theme));
$("#themeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) applyTheme(b.dataset.v); });
(() => { let t = "auto"; try { t = localStorage.getItem("rs-theme") || "auto"; } catch (_) {} applyTheme(t); })();

/* ---------------------------------------------------------------- plan (igual que engine.plan) */
const FPS = 30;
const TRANS = { corte: null, disolver: "fade", negro: "fadeblack", blanco: "fadewhite", barrido: "slideleft", zoom: "zoomin", difuminar: "hblur" };
const TRANS_LABEL = { corte: "Corte", disolver: "Disolver", negro: "A negro", blanco: "A blanco", barrido: "Barrido", zoom: "Zoom", difuminar: "Desenfoque" };
const clipOf = (id) => S.P && S.P.clips.find((c) => c.id === id);
const r30 = (x) => Math.round(x * FPS) / FPS;

function itemSegments(P, it) {
  const c = clipOf(it.clip); if (!c) return [];
  const cin = Math.max(0, +it.in || 0), cout = Math.min(+it.out || c.duration || 0, c.duration || 1e9);
  if (cout - cin < 0.1) return [];
  if (!c.speech) return [[cin, cout]];
  const st = P.settings, pad = +st.padding, maxPause = st.removeSilences ? +st.maxPause : 1e9;
  const W = P.words.filter((w) => w.clip === c.id && w.end > cin && w.start < cout);
  const segs = []; let prevKept = null;
  W.forEach((w, i) => {
    if (w.cut) return;
    let s = w.start - pad, e = w.end + pad;
    if (i > 0 && W[i - 1].cut) s = Math.max(s, W[i - 1].end);
    if (i + 1 < W.length && W[i + 1].cut) e = Math.min(e, W[i + 1].start);
    s = Math.max(cin, s); e = Math.min(cout, e);
    const adj = prevKept !== null && prevKept === i - 1;
    const last = segs[segs.length - 1];
    if (last && adj && w.start - W[i - 1].end <= maxPause) last[1] = Math.max(last[1], e);
    else if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else segs.push([s, e]);
    prevKept = i;
  });
  return segs.filter(([a, b]) => b - a > 0.04);
}
function snap(segs) {
  const out = [];
  for (const [a, b] of segs) {
    const a2 = Math.floor(a * FPS) / FPS, b2 = Math.ceil(b * FPS) / FPS, l = out[out.length - 1];
    if (l && a2 <= l[1]) l[1] = Math.max(l[1], b2); else if (b2 - a2 >= 2 / FPS) out.push([a2, b2]);
  }
  return out;
}
function computePlan(P) {
  const st = P.settings, tr = st.transition || {}, mus = st.music || {};
  const beats = mus.beats || [], beatSync = !!(mus.beatSync && beats.length && mus.file);
  const pace = Math.max(0.6, +st.pace || 2.5);
  const items = [];
  if (st.intro && st.intro.on) items.push({ kind: "card", card: "intro", segs: [], dur: r30(+st.intro.dur || 2) });
  let clock = items.length ? items[0].dur : 0;
  for (const [ti, it] of P.timeline.entries()) {
    const c = clipOf(it.clip);
    if (!c || !["listo", "sin voz", "sin transcribir"].includes(c.status) || c.hasVideo === false) continue;
    let segs = itemSegments(P, it);
    if (!segs.length) continue;
    if (items.length) { const t0 = (it.transition && it.transition.type) || tr.type || "corte"; if (TRANS[t0]) clock -= +((it.transition && it.transition.dur) || tr.dur || 0.4); }
    if (!c.speech) {
      const [a, b] = segs[0];
      let want = it.full ? b - a : Math.min(b - a, pace);
      if (beatSync) {
        const nx = P.timeline[ti + 1], t1 = (nx && nx.transition && nx.transition.type) || tr.type || "corte";
        const half = nx && TRANS[t1] ? +((nx.transition && nx.transition.dur) || tr.dur || 0.4) / 2 : 0;
        const mt = clock - half - (+mus.start || 0);
        const cand = beats.map((x) => x - mt).filter((x) => x >= 0.6 && x <= b - a);
        if (cand.length) want = cand.reduce((p, x) => (Math.abs(x - want) < Math.abs(p - want) ? x : p));
      }
      segs = [[a, a + want]];
    }
    segs = snap(segs);
    if (!segs.length) continue;
    const dur = segs.reduce((n, [a, b]) => n + b - a, 0);
    items.push({ kind: "clip", clip: c.id, segs, dur, speech: !!c.speech, trans: it.transition, ti });
    clock += dur;
  }
  if (st.outro && st.outro.on) items.push({ kind: "card", card: "outro", segs: [], dur: r30(+st.outro.dur || 2.5) });
  const maxd = +st.maxDur || 0;
  if (maxd > 0) {
    let budget = maxd - items.filter((i) => i.kind === "card").reduce((n, i) => n + i.dur, 0);
    const keep = [];
    for (let itm of items) {
      if (itm.kind === "card") { keep.push(itm); continue; }
      if (budget < 0.5) continue;
      if (itm.dur > budget) {
        let left = budget; const segs = [];
        for (const [a, b] of itm.segs) { const take = Math.min(b - a, left); if (take > 0.05) segs.push([a, a + take]); left -= take; if (left <= 0) break; }
        itm = { ...itm, segs, dur: segs.reduce((n, [a, b]) => n + b - a, 0) };
      }
      budget -= itm.dur;
      if (keep.some((k) => k.kind === "clip")) { const t0 = (itm.trans && itm.trans.type) || tr.type || "corte"; if (TRANS[t0]) budget += Math.min(+((itm.trans && itm.trans.dur) || tr.dur || 0.4), itm.dur * 0.4); }
      keep.push(itm);
    }
    items.length = 0; items.push(...keep);
  }
  let start = 0;
  items.forEach((itm, j) => {
    let d = 0; itm.ttype = "corte";
    if (j > 0) {
      let tt = (itm.trans && itm.trans.type) || tr.type || "corte";
      if (tt === "corte" && (itm.kind === "card" || items[j - 1].kind === "card")) tt = "disolver";
      if (TRANS[tt]) d = r30(Math.min(+((itm.trans && itm.trans.dur) || tr.dur || 0.4), itm.dur * 0.4, items[j - 1].dur * 0.4));
      if (d > 0) itm.ttype = tt;
      start -= d;
    }
    itm.tdur = d; itm.start = start; start += itm.dur;
    let acc = 0; itm.cum = itm.segs.map(([a, b]) => { const c0 = acc; acc += b - a; return c0; });
  });
  const mainStart = items.length && items[0].kind === "card" ? (items[1] ? items[1].start : items[0].dur) : 0;
  return { items, total: Math.max(0, start), mainStart };
}
function localMap(itm, t) {
  for (let k = 0; k < itm.segs.length; k++) {
    const [a, b] = itm.segs[k];
    if (t < a) return itm.cum[k];
    if (t <= b) return itm.cum[k] + (t - a);
  }
  return itm.dur;
}
function wordOut(w) {
  for (const itm of S.plan.items) {
    if (itm.kind !== "clip" || !itm.speech || itm.clip !== w.clip) continue;
    const s = localMap(itm, w.start), e = localMap(itm, w.end);
    if (e - s >= 0.02) return [itm.start + s, itm.start + e];
  }
  return null;
}
function captionGroups(P) {
  const st = P.style, kept = [];
  for (const w of P.words) { if (w.cut) continue; const r = wordOut(w); if (r) kept.push({ text: w.text, s: r[0], e: r[1] }); }
  kept.sort((a, b) => a.s - b.s);
  const maxWords = Math.max(1, +st.maxWords || 3);
  let maxChars = st.size >= 150 ? 16 : st.box ? 34 : 26;
  if (["horizontal", "5:4"].includes(P.settings.format)) maxChars = Math.floor(maxChars * 1.6);
  const out = []; let cur = [];
  for (const w of kept) {
    if (cur.length) {
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length, l = cur[cur.length - 1];
      if (cur.length >= maxWords || chars > maxChars || w.s - l.e > 0.6 || /[.?!…]$/.test(l.text)) { out.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}
function recompute() {
  if (!S.P) return;
  S.plan = computePlan(S.P);
  S.groups = captionGroups(S.P);
  $("#durLabel").innerHTML = S.P.clips.length ? `<b>${fmt(S.plan.total)}</b><span class="clips-n"> · ${S.P.clips.length} clip${S.P.clips.length === 1 ? "" : "s"}</span>` : "";
  $("#tcTotal").textContent = fmt(S.plan.total);
  renderTimeline();
}

/* ---------------------------------------------------------------- proyectos y marcas (barra lateral) */
async function loadProjects() { S.projects = await api("GET", "/api/projects"); renderProjects(); }
async function loadBrands() { S.brands = await api("GET", "/api/brands"); renderBrands(); }
function renderProjects() {
  const nav = $("#projList");
  if (!S.projects.length) { nav.innerHTML = `<p class="fine" style="padding:0 8px">Aún no hay proyectos.</p>`; return; }
  nav.innerHTML = S.projects.map((p) => `
    <a href="#${p.id}" class="${S.P && S.P.id === p.id ? "on" : ""}">
      <span class="pthumb" style="${p.thumb ? `background-image:url(/media/${p.id}/file/${p.thumb}_thumb.jpg)` : ""}"></span>
      <span><span class="pn">${esc(p.name)}</span><span class="pm">${p.status === "transcribiendo" ? "procesando…" : `${p.clips} clips · ${fmt(p.outDuration)}`}</span></span>
      <button class="del" data-del="${p.id}" title="Borrar proyecto" aria-label="Borrar ${esc(p.name)}">✕</button>
    </a>`).join("");
}
function renderBrands() {
  $("#brandList").innerHTML = S.brands.map((k) => `
    <a data-brand="${k.id}"><span class="dots"><i style="background:${k.colors.primary}"></i><i style="background:${k.colors.accent}"></i></span>
      <span class="pn">${esc(k.name)}</span><span></span></a>`).join("") +
    `<a data-brand="__new"><span style="text-align:center;font-weight:700;color:var(--accent)">+</span><span class="pn" style="color:var(--accent)">Nueva línea gráfica</span><span></span></a>`;
}
$("#projList").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]"); if (!d) return;
  e.preventDefault(); e.stopPropagation();
  const p = S.projects.find((x) => x.id === d.dataset.del);
  if (!confirm(`¿Borrar «${p ? p.name : ""}» con sus videos y exportaciones? No se puede deshacer.`)) return;
  await api("DELETE", "/api/projects/" + d.dataset.del);
  if (S.P && S.P.id === d.dataset.del) { await loadProjects(); showHome(); return; }
  loadProjects();
});
$("#brandList").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-brand]"); if (!a) return;
  if (a.dataset.brand === "__new") {
    const name = await askName("Nueva línea gráfica", "Colores, letra y logo de una marca o cliente. Se pueden usar en cualquier proyecto.", "Guardar");
    if (!name) return;
    const kit = await api("POST", "/api/brands", { name });
    await loadBrands();
    S.editBrand = kit.id;
  } else S.editBrand = a.dataset.brand;
  if (S.P) { showTab("t-marca"); renderMarca(); } else toast("Abre o crea un proyecto para editar la línea gráfica.");
});
function askName(title, hint, okLabel = "Crear", value = "") {
  const d = $("#nameDlg");
  $("#nameTitle").textContent = title; $("#nameHint").textContent = hint;
  $('#nameDlg [value="ok"]').textContent = okLabel;
  $("#nameInput").value = value; d.returnValue = "";
  d.showModal(); $("#nameInput").focus();
  return new Promise((res) => { d.onclose = () => res(d.returnValue === "ok" ? $("#nameInput").value.trim() || null : null); });
}
$("#nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#nameDlg").close("ok"); } });
async function newProject(defaultName = "") {
  const name = await askName("Nuevo proyecto", "Cada proyecto guarda sus videos, ediciones y exportaciones solo en esta computadora.", "Crear", defaultName);
  if (!name) return null;
  const r = await api("POST", "/api/projects", { name });
  await loadProjects();
  history.replaceState(null, "", "#" + r.project.id);
  await openProject(r.project.id);
  return r.project.id;
}
$("#newProjBtn").addEventListener("click", () => newProject());

/* ---------------------------------------------------------------- inicio: mis proyectos */
function closeProject() {
  stop(); S.useRender = false; S.previewReady = null; $("#renderBadge").hidden = true; clearScreen();
  for (const id in animFrames) { animFrames[id].remove(); delete animFrames[id]; }
  S.P = null; S.plan = null; S.history = [];
}
function renderHome() {
  const g = $("#homeGrid"), L = S.projects || [];
  const ago = (t) => { const d = (Date.now() / 1000 - t) / 86400; return d < 1 ? "hoy" : d < 2 ? "ayer" : d < 30 ? `hace ${Math.floor(d)} días` : new Date(t * 1000).toLocaleDateString("es"); };
  g.innerHTML = `<button class="hcard new" data-new="1"><span class="plus">＋</span><b>Nuevo proyecto</b><span class="fine">Sube tus videos y te guío paso a paso</span></button>` +
    L.map((p) => `<a class="hcard" href="#${p.id}" data-open="${p.id}">
      <span class="hthumb" style="${p.thumb ? `background-image:url(/media/${p.id}/file/${p.thumb}_thumb.jpg)` : ""}">${p.thumb ? "" : '<span class="fine">Sin videos aún</span>'}</span>
      ${S.makeJobs[p.id] ? `<span class="hbusy"><span class="spin"></span> Haciendo el video · ${Math.round((S.makeJobs[p.id].progress || 0) * 100)}%</span>` : ""}
      <span class="hinfo"><b>${esc(p.name)}</b><span class="fine">${p.clips} clip${p.clips === 1 ? "" : "s"} · ${fmt(p.outDuration)} · ${ago(p.updated)}</span></span>
      <button class="hdel" data-hdel="${p.id}" title="Borrar proyecto" aria-label="Borrar ${esc(p.name)}">✕</button></a>`).join("");
}
async function showHome() {
  if (S.P) { try { await flushSave(); } catch (_) {} }
  closeProject();
  if (location.hash) history.replaceState(null, "", location.pathname);
  $("#home").hidden = false; document.body.classList.add("at-home");
  render(); await loadProjects(); renderHome();
}
function hideHome() {
  const h = $("#home"); if (h.hidden) return;
  document.body.classList.remove("at-home");
  h.classList.add("closing"); playEnter("enter");
  setTimeout(() => { h.hidden = true; h.classList.remove("closing"); }, 320);
}
function playEnter(cls) {
  const app = $("#app"); app.classList.remove("enter", "reveal"); void app.offsetWidth; app.classList.add(cls);
  clearTimeout(playEnter.t); playEnter.t = setTimeout(() => app.classList.remove(cls), 1100);
}
window.rsClose = function () {
  const bye = document.createElement("div"); bye.id = "bye"; bye.innerHTML = `<svg viewBox="196 280 600 490"><rect x="236" y="300" width="214" height="76" rx="38" fill="#FFE14D"/><rect x="478" y="300" width="310" height="76" rx="38" fill="currentColor"/><rect x="236" y="474" width="420" height="76" rx="38" fill="currentColor" fill-opacity=".28"/><path d="M196 532 L 724 488" stroke="#3E6CF0" stroke-width="54" stroke-linecap="round"/><rect x="236" y="648" width="330" height="76" rx="38" fill="currentColor"/><path d="M640 628 L 640 744 Q 640 760 654 752 L 752 698 Q 766 686 752 674 L 654 620 Q 640 612 640 628 Z" fill="currentColor"/></svg>`;
  document.body.appendChild(bye); document.body.classList.add("closing-app");
};
$("#homeGrid").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-hdel]");
  if (del) {
    e.preventDefault(); e.stopPropagation();
    const p = S.projects.find((x) => x.id === del.dataset.hdel);
    if (!confirm(`¿Borrar «${p ? p.name : ""}» con sus videos y exportaciones? No se puede deshacer.`)) return;
    await api("DELETE", "/api/projects/" + del.dataset.hdel); await loadProjects(); renderHome(); return;
  }
  if (e.target.closest("[data-new]")) { newProject(); return; }
  const a = e.target.closest("[data-open]");
  if (a) { e.preventDefault(); history.replaceState(null, "", "#" + a.dataset.open); openProject(a.dataset.open); }
});
$("#homeNew").addEventListener("click", () => newProject());
$("#goHome").addEventListener("click", showHome);
$("#goHome").addEventListener("keydown", (e) => { if (e.key === "Enter") showHome(); });

async function openProject(id) {
  if (!id) { showHome(); return; }
  hideHome(); setTimeout(renderMakeOv, 0);
  let P;
  try { P = await api("GET", "/api/projects/" + id); } catch (_) { toast("No encontré ese proyecto."); location.hash = ""; return; }
  const isNew = !S.P || S.P.id !== id;
  S.P = P; S.dirty = false;
  if (isNew) { clearScreen(); S.history = []; S.future = []; S.sel = null; S.selClip = null; S.selBroll = null; S.selJunction = null; S.outT = 0; stop(); S.useRender = false; S.exp = null; $("#renderBadge").hidden = true; }
  render();
  if (isNew) seek(0);
}

function clearScreen() {
  [vA, vB, vBr].forEach((v) => { v.pause(); v.classList.remove("on"); v.dataset.clip = ""; v.removeAttribute("src"); v.load(); });
  $("#cardImg").style.display = "none"; $("#cardImg").removeAttribute("src");
  $("#logoImg").style.display = "none"; $("#cap").innerHTML = ""; S.cur = null; S.capKey = null; music.pause();
}

/* ---------------------------------------------------------------- render general */
function render() {
  const P = S.P;
  $("#projTitle").disabled = !P; $("#projTitle").value = P ? P.name : "";
  const guiding = !P || !P.clips.length || P.guide === true;
  $("#dropZone").hidden = !guiding;
  $("#viewer").classList.toggle("empty", guiding);
  if (S._wasGuiding && !guiding && P) playEnter("reveal");
  S._wasGuiding = guiding;
  $("#app").classList.toggle("guiding", guiding);
  if (guiding) renderGuide();
  if (!P) {
    $("#durLabel").textContent = ""; renderProjects(); $$(".panel").forEach((p) => (p.innerHTML = ""));
    ["#laneMain", "#laneBroll", "#laneMusic", "#laneAnim", "#tlRuler", "#animLayer"].forEach((s) => ($(s).innerHTML = ""));
    ["#exportBtn", "#previewBtn", "#assembleBtn", "#playBtn", "#makeBtn"].forEach((s) => ($(s).disabled = true));
    return;
  }
  P.anims = P.anims || [];
  recompute();
  $("#makeBtn").disabled = !P.clips.length;
  ["#exportBtn", "#previewBtn"].forEach((s) => ($(s).disabled = !(S.plan && S.plan.items.length)));
  $("#assembleBtn").disabled = !P.clips.some((c) => ["listo", "sin voz", "sin transcribir"].includes(c.status));
  $("#playBtn").disabled = !(S.plan && S.plan.items.length);
  histButtons();
  $("#renderToggleWrap").hidden = !S.previewReady || S.previewReady !== P.id;
  const pend = (P.requests || []).filter((r) => r.status === "pendiente").length;
  $("#reqBadge").hidden = !pend; $("#reqBadge").textContent = pend;
  sizeScreen(); renderProjects(); renderPanel(); S.capKey = null; drawFrame(); syncCC();
}
function renderPanel() {
  const f = { "t-texto": renderTexto, "t-clip": renderClips, "t-color": renderColor, "t-audio": renderAudio, "t-estilo": renderEstilo,
    "t-marca": renderMarca, "t-formato": renderFormato, "t-ref": renderRef, "t-pedidos": renderPedidos, "t-log": renderLog, "t-anim": renderAnim }[S.tab];
  if (f && S.P) f();
}
function showTab(id) {
  S.tab = id;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
  $$(".panel").forEach((p) => (p.hidden = p.id !== id));
  renderPanel(); placeSelTools();
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });

/* ---------------------------------------------------------------- guardar, deshacer, sincronizar */
function snapshot() {
  const P = S.P;
  return JSON.stringify({ w: P.words.map((w) => [w.cut, w.by, w.reason, w.text]), tl: P.timeline, br: P.broll, se: P.settings, st: P.style, an: P.anims || [],
    cl: P.clips.map((c) => ({ id: c.id, adjust: c.adjust, gain: c.gain, fit: c.fit, cropX: c.cropX, cropY: c.cropY, speech: c.speech, muted: !!c.muted })) });
}
S.future = [];
function histButtons() { $("#undoBtn").disabled = !S.history.length; $("#redoBtn").disabled = !S.future.length; }
function pushHistory() { if (!S.P) return; S.history.push(snapshot()); if (S.history.length > 80) S.history.shift(); S.future = []; histButtons(); }
function restore(snap) {
  const h = JSON.parse(snap), P = S.P;
  h.w.forEach((x, i) => { const w = P.words[i]; if (w) [w.cut, w.by, w.reason, w.text] = x; });
  P.timeline = h.tl; P.broll = h.br; P.settings = h.se; P.style = h.st; if (h.an) P.anims = h.an;
  h.cl.forEach((x) => { const c = clipOf(x.id); if (c) Object.assign(c, x); });
}
function undo() {
  if (!S.history.length || !S.P) return;
  S.future.push(snapshot()); restore(S.history.pop()); histButtons();
  changed(); toast("Deshecho");
}
function redo() {
  if (!S.future.length || !S.P) return;
  S.history.push(snapshot()); restore(S.future.pop()); histButtons();
  changed(); toast("Rehecho");
}
/* borrar lo que está seleccionado en la línea de tiempo (se recupera con ⌘Z) */
function deleteSelected() {
  const P = S.P; if (!P) return false;
  if (S.selAnim) { pushHistory(); P.anims = P.anims.filter((a) => a.id !== S.selAnim); S.selAnim = null; changed(); toast("Animación quitada · ⌘Z para recuperarla"); return true; }
  if (S.selBroll) { pushHistory(); P.broll = P.broll.filter((x) => x.id !== S.selBroll); S.selBroll = null; changed(); toast("Toma de apoyo quitada · ⌘Z para recuperarla"); return true; }
  if (S.selClip) {
    const n = P.timeline.filter((t) => t.clip === S.selClip).length; if (!n) return false;
    if (P.timeline.length <= 1) { toast("Es la única toma del video: no se puede quitar."); return true; }
    pushHistory();
    const ti = S.selTi;
    if (Number.isInteger(ti) && P.timeline[ti] && P.timeline[ti].clip === S.selClip) P.timeline.splice(ti, 1); // solo esa toma
    else P.timeline = P.timeline.filter((t) => t.clip !== S.selClip);
    S.selClip = null; S.selTi = null; changed(); renderTimeline();
    toast("Toma quitada de la línea de tiempo · ⌘Z para recuperarla"); return true;
  }
  return false;
}
function changed(skipPanel) {
  recompute();
  if (!skipPanel) renderPanel();
  S.capKey = null; drawFrame();
  scheduleSave();
}
function scheduleSave() { S.dirty = true; $("#saveState").textContent = "Guardando…"; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 450); }
async function save() {
  if (!S.P) return;
  if (S.saving) { S.saveTimer = setTimeout(save, 300); return; }
  S.saving = true; S.dirty = false;
  const P = S.P;
  try {
    const r = await api("PUT", "/api/projects/" + P.id, { rev: P.rev, words: P.words, settings: P.settings, style: P.style, name: P.name,
      timeline: P.timeline, broll: P.broll, requests: P.requests, reference: P.reference,
      clips: P.clips.map((c) => ({ id: c.id, name: c.name, adjust: c.adjust || {}, gain: c.gain || 0, fit: c.fit, cropX: c.cropX, cropY: c.cropY, speech: c.speech, muted: !!c.muted })) });
    if (r.__conflict) { S.saving = false; await openProject(P.id); toast("El proyecto cambió mientras editabas (Claude o una transcripción); cargué la versión nueva.", 4200); return; }
    P.rev = r.rev; $("#saveState").textContent = "Guardado";
  } catch (e) { $("#saveState").textContent = "Sin guardar"; toast("No pude guardar: " + e.message); S.dirty = true; }
  S.saving = false;
  if (S.dirty) scheduleSave();
}
async function flushSave() { clearTimeout(S.saveTimer); while (S.saving) await sleep(80); if (S.dirty) await save(); }

async function poll() {
  try {
    if (S.P && !S.dirty && !S.saving) {
      const r = await api("GET", `/api/projects/${S.P.id}/rev`);
      if (r.rev > S.P.rev) {
        const hadLog = (S.P.log || []).length;
        await openProject(S.P.id);
        const L = S.P.log || [];
        if (L.length > hadLog && L[L.length - 1].who === "claude") toast("Claude: " + L[L.length - 1].text, 4500);
        loadProjects();
      }
    }
    const jobs = await api("GET", "/api/jobs");
    trackMakes(jobs);
    const mine = S.P ? jobs.filter((j) => j.project === S.P.id) : [];
    if (!S.uploading) {
      $("#jobChip").hidden = !mine.length;
      if (mine.length) {
        const j = mine[0];
        $("#jobText").textContent = `${j.message || "Trabajando…"}${j.progress > 0.02 ? " " + Math.round(j.progress * 100) + " %" : ""}${mine.length > 1 ? ` (+${mine.length - 1})` : ""}`;
      }
    }
  } catch (_) {}
  setTimeout(poll, 1500);
}

/* ---------------------------------------------------------------- subir */
async function addVideos(files) {
  files = Array.from(files).filter((f) => /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/i.test(f.name));
  if (!files.length) { toast("Esos archivos no parecen videos. Usa MP4 o MOV."); return; }
  if (!S.P) { const id = await newProject(files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")); if (!id) return; }
  const pid = S.P.id;
  S.uploading = true; $("#jobChip").hidden = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      await upload(`/api/projects/${pid}/clips?filename=${encodeURIComponent(f.name)}`, f,
        (x) => ($("#jobText").textContent = `Copiando ${i + 1} de ${files.length}: ${Math.round(x * 100)} %`));
    } catch (e) { toast(e.message, 5000); }
  }
  S.uploading = false;
  await openProject(pid); loadProjects();
  toast(files.length > 1 ? `Agregué ${files.length} videos. Los estoy procesando.` : "Video agregado. Lo estoy procesando.");
}
async function addMusic(file) {
  if (!S.P) return toast("Primero crea o abre un proyecto.");
  S.uploading = true; $("#jobChip").hidden = false;
  try { await upload(`/api/projects/${S.P.id}/music?filename=${encodeURIComponent(file.name)}`, file, (x) => ($("#jobText").textContent = `Copiando música ${Math.round(x * 100)} %`)); }
  catch (e) { S.uploading = false; return toast(e.message, 5000); }
  S.uploading = false;
  toast("Música agregada. Estoy detectando el ritmo.");
}
async function addReference(file) {
  S.uploading = true; $("#jobChip").hidden = false;
  try { await upload(`/api/projects/${S.P.id}/reference?filename=${encodeURIComponent(file.name)}`, file, (x) => ($("#jobText").textContent = `Copiando referencia ${Math.round(x * 100)} %`)); }
  catch (e) { S.uploading = false; return toast(e.message, 5000); }
  S.uploading = false;
  await openProject(S.P.id);
}
$("#fileInput").addEventListener("change", (e) => { addVideos(e.target.files); e.target.value = ""; });
$("#addClips").addEventListener("change", (e) => { addVideos(e.target.files); e.target.value = ""; });
$("#addMusic").addEventListener("change", (e) => { if (e.target.files[0]) addMusic(e.target.files[0]); e.target.value = ""; });
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer.types.includes("Files")) { dragDepth++; $("#app").classList.add("dragging"); } });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#app").classList.remove("dragging"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#app").classList.remove("dragging");
  const fs = Array.from(e.dataTransfer.files || []); if (!fs.length) return;
  const audio = fs.filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i.test(f.name));
  if (audio.length) addMusic(audio[0]);
  const vids = fs.filter((f) => !audio.includes(f));
  if (vids.length) addVideos(vids);
});

/* ---------------------------------------------------------------- reproductor (secuencia en vivo) */
const vA = $("#vA"), vB = $("#vB"), vBr = $("#vBr"), music = new Audio();
music.loop = true;
function activeVideo() { return vB.classList.contains("on") ? vB : vA; }
function otherVideo() { return activeVideo() === vA ? vB : vA; }
function setSrc(v, clip) { if (v.dataset.clip !== clip) { v.dataset.clip = clip; v.src = `/media/${S.P.id}/clip/${clip}`; } }
function findItem(t) {
  const it = S.plan.items;
  for (let j = it.length - 1; j >= 0; j--) if (t >= it[j].start - 1e-6) return j;
  return 0;
}
function locate(t) {
  const j = findItem(t), itm = S.plan.items[j];
  if (!itm) return null;
  const local = clamp(t - itm.start, 0, itm.dur); let k = 0;
  if (itm.kind === "clip") { for (k = itm.segs.length - 1; k > 0; k--) if (local >= itm.cum[k]) break; }
  return { j, itm, k, clipT: itm.kind === "clip" ? itm.segs[k][0] + (local - itm.cum[k]) : 0 };
}
function videoFilter(clipId) {
  const P = S.P, g = P.settings.grade || {}, c = clipOf(clipId) || {}, a = c.adjust || {};
  const cl = (v, m) => Math.max(-m, Math.min(m, +v || 0));
  const look = (S.meta.looks[g.look] || {}).css || "";
  const ex = (+g.exposure || 0) + cl(a.exposure, 0.2), co = +g.contrast || 0, sa = (+g.saturation || 0) + cl(a.saturation, 0.12);
  const te = (+g.temperature || 0) + cl(a.temperature, 0.15);
  let f = look + ` brightness(${1 + ex * 0.12}) contrast(${1 + co * 0.25}) saturate(${Math.max(0, 1 + sa * 0.5)})`;
  if (te > 0) f += ` sepia(${te * 0.12})`; else if (te < 0) f += ` hue-rotate(${-te * 6}deg)`;
  return f;
}
function show(loc) {
  const P = S.P;
  if (!loc) return;
  S.cur = loc;
  const card = $("#cardImg");
  if (loc.itm.kind === "card") {
    card.src = `/media/${P.id}/card/${loc.itm.card}?v=${encodeURIComponent(JSON.stringify([P.settings[loc.itm.card], P.settings.brand, P.settings.format, (S.brands.find((x) => x.id === P.settings.brand) || {}).colors]))}`;
    card.style.display = "block";
    [vA, vB].forEach((v) => { v.pause(); v.classList.remove("on"); });
    return;
  }
  card.style.display = "none";
  const id = loc.itm.clip;
  let v = activeVideo();
  if (v.dataset.clip !== id) { const o = otherVideo(); if (o.dataset.clip === id) v = o; else setSrc(v, id); }
  const tw = transAt(S.outT);
  [vA, vB].forEach((x) => {
    const keep = tw && x !== v && tw.prev.kind === "clip" && x.dataset.clip === tw.prev.clip;
    x.classList.toggle("on", x === v || keep); if (x !== v && !keep) x.pause();
  });
  if (Math.abs(v.currentTime - loc.clipT) > 0.05) v.currentTime = loc.clipT;
  v.style.filter = videoFilter(id);
  const c = clipOf(id), st = P.settings, G = geom();
  v.muted = !!c.muted;
  const sameAR = c.width && Math.abs(c.width / c.height - G.W / G.H) < 0.01;
  const fit = c.fit || st.fit;
  v.style.objectFit = sameAR || fit === "llenar" ? "cover" : "contain";
  v.style.objectPosition = `${(c.cropX ?? st.cropX) * 100}% ${(c.cropY ?? st.cropY) * 100}%`;
  if (S.playing && v.paused) v.play().catch(() => {});
}
/* transiciones en vivo (imitan las de ffmpeg mientras editas) */
function transAt(t) {
  if (!S.plan) return null;
  const it = S.plan.items;
  for (let j = 1; j < it.length; j++) {
    const n = it[j];
    if (n.tdur > 0 && t >= n.start && t < n.start + n.tdur) return { j, next: n, prev: it[j - 1], p: (t - n.start) / n.tdur };
  }
  return null;
}
function clipTimeAt(itm, local) {
  for (let k = 0; k < itm.segs.length; k++) {
    const [a, b] = itm.segs[k], c0 = itm.cum[k];
    if (local <= c0 + (b - a) || k === itm.segs.length - 1) return a + clamp(local - c0, 0, b - a);
  }
  return 0;
}
/* cortes dentro de un mismo video: acercamiento leve alternado (igual que en el render) */
function applyPunch(t) {
  const on = !S.useRender && S.P && S.P.settings.punchIn !== false;
  let z = "";
  const cur = S.cur;
  if (on && cur && cur.itm.kind === "clip" && cur.itm.segs.length > 1 && !transAt(t)) {
    const local = t - cur.itm.start; let idx = 0;
    for (let k = 0; k < cur.itm.segs.length; k++) if (local >= cur.itm.cum[k] - 0.001) idx = k;
    if (idx % 2) z = "1.12";
  }
  [vA, vB].forEach((v) => { const want = v === activeVideo() ? z : ""; if (v.style.scale !== want) v.style.scale = want; });
}
function resetTrans(el) { el.style.opacity = ""; el.style.transform = ""; el.style.zIndex = ""; el.dataset.fx = ""; }
function applyTransition(t) {
  const fade = $("#fadeLayer"), card = $("#cardImg");
  const tw = S.useRender ? null : transAt(t);
  if (!tw) {
    [vA, vB, card].forEach((el) => { if (el.dataset.fx) { resetTrans(el); if (el.tagName === "VIDEO") { el.style.filter = el.dataset.clip ? videoFilter(el.dataset.clip) : ""; el.volume = 1; } } });
    if (S.cur && S.cur.itm.kind === "clip") { const a = activeVideo(), o = otherVideo(); if (o.classList.contains("on") && o !== a && !S.useRender) { o.classList.remove("on"); o.pause(); } }
    fade.style.opacity = 0; return;
  }
  const { prev, next, p } = tw, type = next.ttype;
  const inc = next.kind === "card" ? card : [vA, vB].find((v) => v.dataset.clip === next.clip) || activeVideo();
  let out = null;
  if (prev.kind === "card") out = card;
  else {
    out = [vA, vB].find((v) => v !== inc && v.dataset.clip === prev.clip) || (inc === vA ? vB : vA);
    if (out.dataset.clip !== prev.clip) setSrc(out, prev.clip);
    const want = clipTimeAt(prev, t - prev.start);
    if (Math.abs(out.currentTime - want) > (S.playing ? 0.3 : 0.04)) out.currentTime = want;
    out.classList.add("on"); out.muted = !!(clipOf(prev.clip) || {}).muted;
    if (S.playing && out.paused) out.play().catch(() => {}); if (!S.playing && !out.paused) out.pause();
  }
  if (out === inc) { fade.style.opacity = 0; return; }
  if (out === card || inc === card) card.style.display = "block";
  const e = p * p * (3 - 2 * p);
  const fxv = (el, extra) => { if (el.tagName === "VIDEO") el.style.filter = (videoFilter(el.dataset.clip) + " " + (extra || "")).trim(); };
  [inc, out].forEach((el) => (el.dataset.fx = "1"));
  inc.style.zIndex = 1; out.style.zIndex = 0; inc.style.transform = out.style.transform = ""; fade.style.opacity = 0;
  if (inc.tagName === "VIDEO") inc.volume = clamp(e, 0, 1); if (out.tagName === "VIDEO") out.volume = clamp(1 - e, 0, 1);
  if (type === "negro" || type === "blanco") {
    fade.style.background = type === "negro" ? "#000" : "#fff";
    fade.style.opacity = p < 0.5 ? p * 2 : (1 - p) * 2;
    inc.style.opacity = p < 0.5 ? 0 : 1; out.style.opacity = 1; fxv(inc); fxv(out);
  } else if (type === "barrido") {
    inc.style.opacity = out.style.opacity = 1;
    inc.style.transform = `translateX(${(1 - e) * 100}%)`; out.style.transform = `translateX(${-e * 100}%)`; fxv(inc); fxv(out);
  } else if (type === "zoom") {
    out.style.opacity = 1; out.style.transform = `scale(${1 + e * 0.6})`; inc.style.opacity = e; fxv(inc); fxv(out);
  } else if (type === "difuminar") {
    out.style.opacity = 1; inc.style.opacity = e; fxv(out, `blur(${(e * 14).toFixed(1)}px)`); fxv(inc, `blur(${((1 - e) * 14).toFixed(1)}px)`);
  } else { // disolver
    out.style.opacity = 1; inc.style.opacity = e; fxv(inc); fxv(out);
  }
}
function seek(t) {
  if (!S.P || !S.plan) return;
  S.outT = clamp(t, 0, S.plan.total);
  if (S.useRender) { vA.currentTime = S.outT; drawFrame(); return; }
  if (!S.plan.items.length) return;
  const loc = locate(S.outT);
  show(loc);
  if (loc && loc.itm.kind === "card") S.cardClock = { out: S.outT, perf: performance.now() };
  syncMusic(true); syncVoice(true); S.capKey = null; drawFrame();
  $("#tcNow").textContent = fmt(S.outT);
}
function play() {
  if (!S.P || !S.plan || !S.plan.items.length) return;
  if (S.outT >= S.plan.total - 0.05) seek(0);
  S.playing = true; setPlayIcon();
  if (S.useRender) { vA.play().catch(() => {}); return; }
  const loc = locate(S.outT); show(loc);
  if (loc.itm.kind === "card") S.cardClock = { out: S.outT, perf: performance.now() };
  else activeVideo().play().catch(() => {});
  syncMusic(true); syncVoice(true);
}
function stop() {
  S.playing = false; setPlayIcon();
  [vA, vB, vBr].forEach((v) => v.pause()); music.pause(); voiceEl.pause();
}
function togglePlay() { S.playing ? stop() : play(); }
function setPlayIcon() {
  $("#playIcon").innerHTML = S.playing ? '<path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" fill="currentColor"/>' : '<path d="M6 4l10 6-10 6z" fill="currentColor"/>';
  $("#playBtn").setAttribute("aria-label", S.playing ? "Pausar" : "Reproducir");
}
$("#playBtn").addEventListener("click", togglePlay);
$("#screen").addEventListener("click", togglePlay);
function syncMusic(force) {
  const m = S.P && S.P.settings.music;
  if (!m || !m.file || S.useRender) { music.pause(); return; }
  const want = `/media/${S.P.id}/music?f=${encodeURIComponent(m.file)}`;
  if (music.dataset.src !== want) { music.dataset.src = want; music.src = want; }
  const dur = m.duration || 1e9;
  const t = ((+m.start || 0) + S.outT) % dur;
  if (force || Math.abs(music.currentTime - t) > 0.3) { try { music.currentTime = t; } catch (_) {} }
  let vol = +m.volume || 0.35;
  const anyVoice = (S.P.settings.voice && S.P.settings.voice.file) || S.plan.items.some((i) => i.speech && !(clipOf(i.clip) || {}).muted);
  if (!anyVoice && !m.userVol) vol = 1; // sin voces la música es lo principal
  if (m.duck && S.cur && S.cur.itm.speech) vol *= 0.4;
  const fi = +m.fadeIn || 0, fo = +m.fadeOut || 0;
  if (fi && S.outT < fi) vol *= S.outT / fi;
  if (fo && S.outT > S.plan.total - fo) vol *= Math.max(0, (S.plan.total - S.outT) / fo);
  music.volume = clamp(vol, 0, 1);
  if (S.playing && music.paused) music.play().catch(() => {});
  if (!S.playing) music.pause();
}
const voiceEl = new Audio();
function syncVoice(force) {
  const vz = S.P && S.P.settings.voice;
  if (!vz || !vz.file || S.useRender || !S.plan) { voiceEl.pause(); return; }
  const want = `/media/${S.P.id}/voice?f=${encodeURIComponent(vz.file)}`;
  if (voiceEl.dataset.src !== want) { voiceEl.dataset.src = want; voiceEl.src = want; }
  const t = S.outT - S.plan.mainStart, inside = t >= 0 && t < (vz.duration || 0);
  if (inside && (force || Math.abs(voiceEl.currentTime - t) > 0.25)) { try { voiceEl.currentTime = t; } catch (_) {} }
  if (S.playing && inside && voiceEl.paused) voiceEl.play().catch(() => {});
  if (!S.playing || !inside) voiceEl.pause();
}
function tick() {
  if (S.P && S.plan && S.plan.items.length) {
    if (S.useRender) {
      S.outT = vA.currentTime || 0;
      if (S.playing && vA.ended) stop();
    } else if (S.playing && S.cur) {
      const it = S.plan.items, j = S.cur.j, itm = S.cur.itm, nxt = it[j + 1];
      if (itm.kind === "card") {
        S.outT = S.cardClock.out + (performance.now() - S.cardClock.perf) / 1000;
      } else {
        const v = activeVideo(), seg = itm.segs[S.cur.k], t = v.currentTime;
        S.outT = itm.start + itm.cum[S.cur.k] + clamp(t - seg[0], 0, seg[1] - seg[0]);
        if (t >= seg[1] - 0.02 && S.cur.k + 1 < itm.segs.length) { S.cur.k++; v.currentTime = itm.segs[S.cur.k][0]; }
        if (nxt && nxt.kind === "clip" && nxt.clip !== itm.clip && nxt.start - S.outT < 1.2) {
          const o = otherVideo();
          if (o.dataset.clip !== nxt.clip) { setSrc(o, nxt.clip); o.currentTime = nxt.segs[0][0]; }
        }
      }
      if (nxt && S.outT >= nxt.start) { show(locate(S.outT + 0.001)); if (S.cur.itm.kind === "card") S.cardClock = { out: S.outT, perf: performance.now() }; }
      else if (!nxt && S.outT >= itm.start + itm.dur - 0.02) { stop(); S.outT = S.plan.total; }
      syncMusic(false); syncVoice(false);
    }
    $("#tcNow").textContent = fmt(S.outT);
    $("#tlHead").style.left = (74 + S.outT * (S.pps || 1)) + "px";
    if (S.playing) drawFrame();
    highlightNow();
  }
  requestAnimationFrame(tick);
}

/* capas sobre el video: apoyo (b-roll), logo y subtítulos */
function geom(fmtName) {
  const f = S.meta.formats[fmtName || (S.P && S.P.settings.format) || "vertical"] || S.meta.formats.vertical;
  const W = f.w, H = f.h, k = Math.min(W, H) / 1080, tall = H > W * 1.05;
  return { W, H, k, label: f.label, bottom: H * (tall ? 0.224 : 0.085), top: H * (tall ? 0.156 : 0.08), maxw: tall || Math.abs(W - H) < 2 ? W - 180 * k : W * 0.72 };
}
function sizeScreen() {
  if (!S.meta) return;
  const G = geom(), wrap = $("#screenWrap"), scr = $("#screen");
  const aw = wrap.clientWidth - 8, ah = wrap.clientHeight - 8, r = G.W / G.H;
  const w = Math.max(80, Math.min(aw, ah * r));
  scr.style.width = Math.round(w) + "px"; scr.style.height = Math.round(w / r) + "px";
  S.capKey = null;
}
window.addEventListener("resize", () => { placeSelTools(); });
function drawFrame() {
  if (!S.P || !S.plan) return;
  const P = S.P, t = S.outT, G = geom(), scr = $("#screen"), k = scr.clientWidth / G.W;
  if (S.useRender) { vBr.classList.remove("on"); $("#cap").innerHTML = ""; $("#logoImg").style.display = "none"; S.capKey = null; drawAnims(-1, G, k); return; }
  const b = (P.broll || []).find((x) => t >= S.plan.mainStart + +x.at && t < S.plan.mainStart + +x.at + +x.dur);
  if (b && clipOf(b.clip)) {
    setSrc(vBr, b.clip);
    const want = +b.srcIn + (t - S.plan.mainStart - +b.at);
    if (Math.abs(vBr.currentTime - want) > 0.25) vBr.currentTime = want;
    vBr.style.filter = videoFilter(b.clip);
    vBr.classList.add("on");
    if (S.playing && vBr.paused) vBr.play().catch(() => {});
    if (!S.playing) vBr.pause();
  } else { vBr.classList.remove("on"); if (!vBr.paused) vBr.pause(); }
  const lg = P.settings.logo || {}, kit = S.brands.find((x) => x.id === P.settings.brand), img = $("#logoImg");
  if (lg.on && kit && kit.logo) {
    const src = `/brand/${kit.id}/logo.png?${kit.logoV || ""}`;
    if (img.getAttribute("src") !== src) img.src = src;
    img.style.display = "block";
    const lw = G.W * (+lg.size || 0.14) * k, mg = 48 * G.k * k, tall = G.H > G.W * 1.05, pos = lg.pos || "arriba-derecha";
    img.style.width = lw + "px"; img.style.opacity = lg.opacity ?? 0.9;
    img.style.left = img.style.right = img.style.top = img.style.bottom = "auto"; img.style.transform = "";
    const side = pos.split("-")[1];
    if (side === "izquierda") img.style.left = mg + "px"; else if (side === "derecha") img.style.right = mg + "px"; else { img.style.left = "50%"; img.style.transform = "translateX(-50%)"; }
    if (pos.startsWith("arriba")) img.style.top = (tall ? G.top * 0.5 * k : mg) + "px"; else img.style.bottom = (tall ? G.bottom * 0.45 * k : mg) + "px";
  } else img.style.display = "none";
  applyTransition(t);
  applyPunch(t);
  drawAnims(t, G, k);
  drawCaption(t, G, k);
}
const FONT_EM = { "Poppins Black": 0.568, "Poppins ExtraBold": 0.568, Poppins: 0.568, Anton: 0.577, "Bebas Neue": 0.769 };
function capText(t, up) { t = t.trim().replace(/[,;:]+$/, ""); if (!t.endsWith("...")) t = t.replace(/\.$/, ""); return up ? t.toUpperCase() : t; }
function drawCaption(t, G, k) {
  const cap = $("#cap"), P = S.P, st = P.style;
  if (!P.settings.subtitles) { cap.innerHTML = ""; S.capKey = null; return; }
  let g = null, gi = -1;
  for (let i = 0; i < S.groups.length; i++) {
    const X = S.groups[i]; let end = X[X.length - 1].e + 0.25;
    if (i + 1 < S.groups.length) end = Math.min(end, S.groups[i + 1][0].s);
    end = Math.max(end, X[X.length - 1].e);
    if (t >= X[0].s && t < end) { g = X; gi = i; break; }
  }
  const j = g ? g.findIndex((w, jj) => jj + 1 >= g.length || t < g[jj + 1].s) : -1;
  const key = g ? `${gi}:${j}:${JSON.stringify(st)}:${k}:${P.settings.brand}:${P.settings.format}` : "";
  if (key === S.capKey) return;
  S.capKey = key;
  if (!g) { cap.innerHTML = ""; return; }
  const mode = st.mode || "resaltar";
  const parts = g.map((w0, i) => {
    const w = esc(capText(w0.text, st.uppercase));
    if (mode === "resaltar") return `<span class="cw" style="color:${i === j ? st.highlight + ";font-size:1.12em" : st.color}">${w}</span>`;
    if (mode === "progresivo") return `<span class="cw" style="color:${i === j ? st.highlight : st.color};${i > j ? "opacity:.44" : ""}">${w}</span>`;
    if (i > j) return "";
    return `<span class="cw" style="color:${i === j ? st.highlight : st.color};${i === j ? "animation:pop .11s ease-out" : ""}">${w}</span>`;
  }).filter(Boolean);
  cap.innerHTML = `<span class="line">${parts.join(" ")}</span>`;
  const kit = S.brands.find((x) => x.id === P.settings.brand);
  let family = st.font, em = FONT_EM[st.font] || 0.57;
  if (st.font === "marca" && kit && kit.fontFile) { family = "MarcaFont-" + kit.id; em = kit.fontEm || 0.6; ensureBrandFont(kit); }
  const kk = k * G.k, px = em * st.size * kk;
  cap.style.fontFamily = `"${family}"`; cap.style.fontWeight = st.font === "Poppins" ? "700" : "400";
  cap.style.fontSize = px + "px"; cap.className = "cap" + (st.box ? " box" : "");
  const ow = st.box ? 0 : (+st.outlineWidth || 0) * kk * 2;
  cap.style.webkitTextStroke = ow ? `${ow}px ${st.outline}` : "0"; cap.style.paintOrder = "stroke fill";
  const side = (G.W - G.maxw) / 2 / G.W * 100;
  cap.style.left = cap.style.right = side + "%";
  const line = cap.querySelector(".line");
  line.style.background = st.box ? hexA(st.boxColor, 0.75) : "transparent";
  line.style.padding = st.box ? `${6 * kk}px ${18 * kk}px` : "0";
  cap.style.top = cap.style.bottom = ""; cap.style.transform = "";
  const pos = st.position || "abajo";
  if (pos === "abajo") cap.style.bottom = (G.bottom / G.H * 100) + "%";
  else if (pos === "arriba") cap.style.top = (G.top / G.H * 100) + "%";
  else { cap.style.top = "50%"; cap.style.transform = "translateY(-50%)"; }
}
const loadedFonts = new Set();
function ensureBrandFont(kit) {
  const fam = "MarcaFont-" + kit.id, key = fam + kit.fontFile + (kit.fontName || "");
  if (loadedFonts.has(key)) return;
  loadedFonts.add(key);
  const ff = new FontFace(fam, `url(/brand/${kit.id}/${kit.fontFile}?${Date.now()})`);
  ff.load().then((f) => { document.fonts.add(f); S.capKey = null; drawFrame(); }).catch(() => {});
}
function hexA(h, a) { const n = parseInt((h || "#000000").slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const popStyle = document.createElement("style");
popStyle.textContent = "@keyframes pop{from{transform:scale(.7)}to{transform:scale(1)}}";
document.head.appendChild(popStyle);

/* vista previa final (render exacto) */
$("#previewBtn").addEventListener("click", async () => {
  if (!S.P) return;
  await flushSave();
  try { await api("POST", `/api/projects/${S.P.id}/preview`, {}); } catch (e) { return toast(e.message, 5000); }
  toast("Preparando la vista previa final. Te aviso cuando esté.");
  const pid = S.P.id;
  for (;;) {
    await sleep(1500);
    const jobs = await api("GET", "/api/jobs");
    if (!jobs.some((j) => j.project === pid && j.kind === "preview")) break;
  }
  if (!S.P || S.P.id !== pid) return;
  S.previewReady = pid; $("#renderToggleWrap").hidden = false; $("#renderToggle").checked = true;
  setRender(true); toast("Vista previa final lista: así se verá el video exportado.");
});
function setRender(on) {
  stop();
  S.useRender = on;
  $("#renderBadge").hidden = !on;
  if (on) {
    vA.dataset.clip = "__render"; vA.src = `/media/${S.P.id}/file/preview.mp4?${Date.now()}`;
    vA.style.filter = ""; vA.style.objectFit = "contain";
    vA.classList.add("on"); vB.classList.remove("on"); $("#cardImg").style.display = "none";
    vA.addEventListener("loadedmetadata", () => { vA.currentTime = S.outT; }, { once: true });
  } else { vA.dataset.clip = ""; vA.removeAttribute("src"); seek(S.outT); }
  drawFrame();
}
$("#renderToggle").addEventListener("change", (e) => setRender(e.target.checked));

/* ---------------------------------------------------------------- línea de tiempo */
function renderTimeline() {
  const P = S.P, can = $("#tlCanvas");
  if (!P || !S.plan) return;
  const total = Math.max(S.plan.total, 5), avail = $("#tlScroll").clientWidth - 74 - 16;
  const pps = S.pps = Math.max(8, avail / total);
  can.style.width = (74 + total * pps + 16) + "px";
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 46) || 60;
  let rh = "";
  for (let t = 0; t <= total + 0.001; t += step) rh += `<i style="left:${t * pps}px"></i><span style="left:${t * pps}px">${t >= 60 ? fmt(t).replace(/\.0$/, "") : Math.round(t * 10) / 10 + "s"}</span>`;
  $("#tlRuler").innerHTML = rh;
  let mh = "";
  S.plan.items.forEach((itm, j) => {
    const left = itm.start * pps, w = Math.max(6, itm.dur * pps - 2);
    if (itm.kind === "card") mh += `<div class="blk card" data-card="${itm.card}" style="left:${left}px;width:${w}px"><span>${itm.card === "intro" ? "Intro" : "Cierre"}</span></div>`;
    else {
      const c = clipOf(itm.clip);
      mh += `<div class="blk ${S.selClip === itm.clip && !S.selBroll ? "sel" : ""}" data-item="${itm.clip}" data-ti="${S.plan.items.filter((x) => x.kind === "clip").indexOf(itm)}" style="left:${left}px;width:${w}px;background-image:url(/media/${P.id}/file/${itm.clip}_strip.jpg)">
        ${itm.speech ? '<b class="voice">VOZ</b>' : ""}<span>${esc(c ? c.name : itm.clip)}</span></div>`;
    }
    if (j > 0) mh += `<div class="tchip ${S.selJunction === j ? "on" : ""}" data-junction="${j}" style="left:${(itm.start + itm.tdur / 2) * pps}px" title="${TRANS_LABEL[itm.ttype] || "Corte"}"></div>`;
  });
  const pending = P.clips.filter((c) => !["listo", "sin voz", "sin transcribir"].includes(c.status));
  if (pending.length) mh += `<div class="fine" style="position:absolute;right:8px;top:20px">${pending.length} clip${pending.length > 1 ? "s" : ""} procesándose…</div>`;
  if (!S.plan.items.length && !pending.length && P.clips.length) mh += `<div class="fine" style="position:absolute;left:10px;top:20px">La secuencia está vacía. Usa «Armar video» o la pestaña Clips.</div>`;
  $("#laneMain").innerHTML = mh;
  $("#laneBroll").innerHTML = (P.broll || []).map((b) => {
    const c = clipOf(b.clip); if (!c) return "";
    return `<div class="blk broll ${S.selBroll === b.id ? "sel" : ""}" data-broll="${b.id}" style="left:${(S.plan.mainStart + +b.at) * pps}px;width:${Math.max(6, b.dur * pps - 2)}px;background-image:url(/media/${P.id}/file/${b.clip}_strip.jpg)"><span>${esc(c.name)}</span></div>`;
  }).join("");
  $("#laneAnim").innerHTML = (P.anims || []).map((a) => `<div class="blk animb k-${a.kind} ${S.selAnim === a.id ? "sel" : ""} ${a.on === false ? "off" : ""}" data-anim="${a.id}" style="left:${(+a.start) * pps}px;width:${Math.max(6, (+a.dur) * pps - 2)}px"><span>${esc(a.text || ANIM_LABEL[a.kind] || "")}</span></div>`).join("")
    || `<span class="fine" style="position:absolute;left:10px;top:3px">Sin animaciones · usa «+ Animación» o «Hacer mi video»</span>`;
  const m = P.settings.music;
  if (m && m.file) {
    const w = Math.min(total, Math.max(0, (m.duration || total) - (+m.start || 0))) * pps;
    let bh = "";
    if (m.beatSync) for (const b of m.beats || []) { const x = b - (+m.start || 0); if (x >= 0 && x <= total) bh += `<i class="beat" style="left:${x * pps}px"></i>`; }
    $("#laneMusic").innerHTML = `<div class="mwave" style="left:0;width:${w}px;background-image:url(/media/${P.id}/file/music_wave.png?${encodeURIComponent(m.file + m.duration)});background-size:${(m.duration || total) * pps}px 100%;background-position:${-(+m.start || 0) * pps}px 0"></div>${bh}`;
  } else $("#laneMusic").innerHTML = `<span class="fine" style="position:absolute;left:10px;top:3px">Sin música · arrastra un MP3 o usa «+ Música»</span>`;
}
$("#tlRuler").addEventListener("pointerdown", (e) => tlSeek(e));
["#laneMain", "#laneBroll", "#laneMusic", "#laneAnim"].forEach((s) => $(s).addEventListener("pointerdown", (e) => {
  if (e.target.closest(".blk") || e.target.closest(".tchip")) return;
  tlSeek(e);
}));
function tlSeek(e) {
  if (S.useRender) { $("#renderToggle").checked = false; setRender(false); }
  const r = $("#tlCanvas").getBoundingClientRect();
  const go = (ev) => seek(((ev.clientX - r.left) - 74) / S.pps);
  go(e);
  const mv = (ev) => go(ev), up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
}
$("#laneMain").addEventListener("pointerdown", (e) => {
  const chip = e.target.closest(".tchip");
  if (chip) { S.selJunction = +chip.dataset.junction; renderTimeline(); showTab("t-estilo"); return; }
  if (e.target.closest("[data-card]")) { showTab("t-marca"); return; }
  const blk = e.target.closest("[data-item]"); if (!blk) return;
  e.preventDefault();
  const id = blk.dataset.item, x0 = e.clientX, left0 = blk.offsetLeft;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 5) return;
    moved = true; blk.classList.add("dragging"); blk.style.left = (left0 + ev.clientX - x0) + "px";
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
    if (!moved) {
      if (S.selClip === id && !S.selBroll) { clearSelection(); return; } // segundo clic: suelta el clip
      S.selClip = id; S.selBroll = null; S.selTi = +blk.dataset.ti;
      const itm = S.plan.items.find((i) => i.clip === id);
      if (itm) seek(itm.start + 0.01);
      renderTimeline(); showTab("t-clip"); return;
    }
    const center = (left0 + ev.clientX - x0 + blk.offsetWidth / 2) / S.pps;
    const order = S.plan.items.filter((i) => i.kind === "clip").map((i) => ({ id: i.clip, mid: i.start + i.dur / 2 }));
    const others = order.filter((o) => o.id !== id);
    let idx = others.findIndex((o) => center < o.mid); if (idx < 0) idx = others.length;
    const newIds = others.map((o) => o.id); newIds.splice(idx, 0, id);
    pushHistory();
    const P = S.P, byId = Object.fromEntries(P.timeline.map((t) => [t.clip, t]));
    P.timeline = newIds.map((i) => byId[i]).filter(Boolean).concat(P.timeline.filter((t) => !newIds.includes(t.clip)));
    changed();
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
});
$("#laneBroll").addEventListener("pointerdown", (e) => {
  const blk = e.target.closest("[data-broll]"); if (!blk) return;
  e.preventDefault();
  const b = S.P.broll.find((x) => x.id === blk.dataset.broll), x0 = e.clientX, at0 = +b.at;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 4) return;
    if (!moved) pushHistory();
    moved = true;
    b.at = Math.round(clamp(at0 + (ev.clientX - x0) / S.pps, 0, Math.max(0, S.plan.total - S.plan.mainStart - 0.3)) * 10) / 10;
    blk.style.left = (S.plan.mainStart + b.at) * S.pps + "px";
  };
  const up = () => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
    S.selBroll = b.id; S.selClip = b.clip;
    if (moved) changed(); else { seek(S.plan.mainStart + +b.at + 0.01); renderTimeline(); showTab("t-clip"); }
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
});

/* ---------------------------------------------------------------- pestaña Texto */
function orderedClips() {
  const P = S.P, seen = new Set(), out = [];
  for (const t of P.timeline) { const c = clipOf(t.clip); if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } }
  for (const c of P.clips) if (!seen.has(c.id)) out.push(c);
  return out;
}
function setSubs(on) {
  pushHistory(); S.P.settings.subtitles = !!on; changed(); syncCC(); S.capKey = null; drawFrame();
  const t = $("#subsOnT"); if (t) t.checked = !!on; const e = $("#subsOn"); if (e) e.checked = !!on;
  toast(on ? "Subtítulos activados." : "Subtítulos ocultos. Puedes volver a activarlos con CC.");
}
function syncCC() { const b = $("#ccBtn"); if (b && S.P) b.classList.toggle("on", !!S.P.settings.subtitles); }
$("#ccBtn").addEventListener("click", () => { if (S.P) setSubs(!S.P.settings.subtitles); });
function renderTexto() {
  const P = S.P, box = $("#t-texto");
  const speechClips = orderedClips().filter((c) => c.speech);
  if (!speechClips.length) {
    const busy = P.clips.some((c) => !["listo", "sin voz", "sin transcribir"].includes(c.status));
    const pendT = P.clips.filter((c) => c.status === "sin transcribir").length;
    box.innerHTML = pendT && !busy
      ? `<p class="empty-note">Tus videos aún no están transcritos (${pendT}). Transcríbelos para tener subtítulos y poder cortar silencios y muletillas.</p><button class="btn primary" id="tNow">Transcribir ahora</button>`
      : `<p class="empty-note">${busy ? "Procesando… el texto aparece aquí en cuanto termine." : P.clips.length ? "Ningún clip tiene voz. Arma el montaje en la línea de tiempo y la pestaña Clips." : "Agrega videos para ver aquí lo que se dice."}</p>`;
    const tb = $("#tNow"); if (tb) tb.onclick = () => transcribeNow();
    return;
  }
  const W = P.words, html = [`<div class="row-f subsrow"><label for="subsOnT"><b>Subtítulos en el video</b><span class="fine" style="display:block;margin:0">Apagarlos no borra el texto: sigue sirviendo para cortar.</span></label><input type="checkbox" class="switch" id="subsOnT" ${P.settings.subtitles ? "checked" : ""}></div>
    <div class="tip">Clic en una palabra para ir a ese momento. Arrastra o usa Shift para elegir varias y pulsa <b>⌫</b> para quitarlas. Doble clic corrige el subtítulo.</div>
    <div class="row-f" style="margin-top:0"><span class="fine" style="margin:0"><s style="text-decoration-color:var(--accent);text-decoration-thickness:2px">tachado</s> no sale · <u style="text-decoration:underline wavy var(--warn)">ondulado</u> posible muletilla</span>
    <button class="btn small" id="autoBtn">Limpiar de nuevo</button></div><div class="text" id="text" tabindex="0">`];
  for (const c of speechClips) {
    const inTl = P.timeline.some((t) => t.clip === c.id);
    html.push(`<div class="clip-h"><img src="/media/${P.id}/file/${c.id}_thumb.jpg" alt="">${esc(c.name)}${inTl ? "" : " · fuera de la secuencia"}</div>`);
    const idx = []; W.forEach((w, i) => w.clip === c.id && idx.push(i));
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const gone = cur.every((i) => W[i].cut);
      html.push(`<p class="ph${gone ? " gone" : ""}"><span class="t" data-word="${cur[0]}">${fmt(W[cur[0]].start)}</span>`);
      let lastR = null;
      for (const i of cur) {
        const w = W[i];
        if (w.cut) {
          const r = w.by === "claude" ? "Claude" : w.by === "user" ? null : w.reason;
          if (r && r !== lastR) html.push(`<span class="why${w.by === "claude" ? " claude" : ""}">${esc(r)}</span>`);
          lastR = r;
        } else lastR = null;
        const cls = ["w"];
        if (w.cut) cls.push("cut"); else if (w.suggest) cls.push("sug");
        if (w.text !== w.orig) cls.push("fixed");
        if (S.sel && i >= S.sel[0] && i <= S.sel[1]) cls.push("sel");
        html.push(`<span class="${cls.join(" ")}" data-i="${i}"${w.text !== w.orig ? ` title="Original: ${esc(w.orig)}"` : ""}>${esc(w.text)}</span> `);
      }
      html.push("</p>"); cur = [];
    };
    idx.forEach((i) => {
      if (cur.length) { const p = W[cur[cur.length - 1]]; if (W[i].start - p.end > 0.55 || /[.?!…]$/.test(p.text)) flush(); }
      cur.push(i);
    });
    flush();
  }
  html.push("</div>");
  box.innerHTML = html.join("");
  S.nowEl = null; S.nowIdx = null;
  $("#subsOnT").onchange = (e) => setSubs(e.target.checked);
  $("#autoBtn").onclick = async () => { await flushSave(); pushHistory(); S.P = await api("POST", `/api/projects/${P.id}/autoclean`); render(); const s = S.P.autoStats || {}; toast(`Marqué ${s["muletilla"] || 0} muletillas, ${s["repetición"] || 0} repeticiones y ${s["toma repetida"] || 0} palabras de tomas repetidas.`); };
  wireText();
  placeSelTools();
}
function wordEl(i) { return $(`#text .w[data-i="${i}"]`); }
function setSel(a, b) {
  S.sel = a == null ? null : [Math.min(a, b), Math.max(a, b)];
  $$("#text .w.sel").forEach((e) => e.classList.remove("sel"));
  if (S.sel) for (let i = S.sel[0]; i <= S.sel[1]; i++) { const e = wordEl(i); if (e) e.classList.add("sel"); }
  placeSelTools();
}
const rangeIdx = () => { const o = []; if (S.sel) for (let i = S.sel[0]; i <= S.sel[1]; i++) o.push(i); return o; };
function placeSelTools() {
  const tools = $("#selTools");
  if (!S.sel || !S.P || S.dragSel || S.tab !== "t-texto") { tools.hidden = true; return; }
  const a = wordEl(S.sel[0]), b = wordEl(S.sel[1]); if (!a || !b) { tools.hidden = true; return; }
  tools.hidden = false;
  const idx = rangeIdx();
  tools.querySelector('[data-act="cut"]').hidden = idx.every((i) => S.P.words[i].cut);
  tools.querySelector('[data-act="keep"]').hidden = !idx.some((i) => S.P.words[i].cut);
  tools.querySelector('[data-act="edit"]').hidden = S.sel[0] !== S.sel[1];
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  let top = ra.top - tools.offsetHeight - 8;
  if (top < 60) top = rb.bottom + 8;
  tools.style.top = top + "px";
  tools.style.left = clamp(ra.left, 12, window.innerWidth - tools.offsetWidth - 12) + "px";
}
$(".panels").addEventListener("scroll", placeSelTools);
function wireText() {
  const text = $("#text"); if (!text) return;
  text.addEventListener("mousedown", (e) => {
    const ts = e.target.closest("[data-word]");
    if (ts) { seekWord(+ts.dataset.word); return; }
    const t = e.target.closest(".w"); if (!t) { setSel(null); return; }
    e.preventDefault(); text.focus({ preventScroll: true });
    const i = +t.dataset.i;
    if (e.shiftKey && S.anchor != null) setSel(S.anchor, i); else { S.anchor = i; setSel(i, i); }
    S.dragSel = true; S.dragMoved = false; $("#selTools").hidden = true;
  });
  text.addEventListener("dblclick", (e) => { const t = e.target.closest(".w"); if (t) editWord(+t.dataset.i); });
}
window.addEventListener("mousemove", (e) => {
  if (!S.dragSel) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY), t = hit && hit.closest("#text .w");
  if (!t) return;
  S.dragMoved = true; setSel(S.anchor, +t.dataset.i);
});
window.addEventListener("mouseup", (e) => {
  if (!S.dragSel) return;
  S.dragSel = false; placeSelTools();
  if (!S.dragMoved && S.sel && S.sel[0] === S.sel[1] && !e.shiftKey) seekWord(S.sel[0]);
});
function seekWord(i) {
  const w = S.P.words[i]; if (!w) return;
  if (S.useRender) { $("#renderToggle").checked = false; setRender(false); }
  const r = wordOut(w);
  if (r) return seek(r[0] + 0.001);
  const later = S.P.words.slice(i).map(wordOut).find(Boolean);
  if (later) seek(later[0]);
}
$("#selTools").addEventListener("mousedown", (e) => e.preventDefault());
$("#selTools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b || !S.sel) return;
  const a = b.dataset.act;
  if (a === "cut") setCut(rangeIdx(), true);
  if (a === "keep") setCut(rangeIdx(), false);
  if (a === "edit") editWord(S.sel[0]);
  if (a === "play") { seekWord(S.sel[0]); play(); }
});
function setCut(idx, cut) {
  if (!idx.length) return;
  pushHistory();
  for (const i of idx) Object.assign(S.P.words[i], cut ? { cut: true, by: "user", reason: "quitado a mano" } : { cut: false, by: "keep", reason: "" });
  changed();
}
async function editWord(i) {
  const w = S.P.words[i];
  const v = await askName("Corregir subtítulo", "Cambia cómo se escribe en pantalla. El audio no cambia.", "Guardar", w.text);
  if (!v || v === w.text) return;
  pushHistory(); w.text = v; changed();
}
let nowTimer = 0;
function highlightNow() {
  if (S.tab !== "t-texto" || !S.playing || S.useRender) { if (S.nowEl) { S.nowEl.classList.remove("now"); S.nowEl = null; S.nowIdx = null; } return; }
  if (++nowTimer % 4) return;
  const c = S.cur && S.cur.itm.kind === "clip" ? S.cur.itm.clip : null;
  let idx = -1;
  if (c) { const t = activeVideo().currentTime; S.P.words.forEach((w, i) => { if (w.clip === c && w.start <= t && t <= w.end + 0.05) idx = i; }); }
  if (idx === S.nowIdx) return;
  S.nowIdx = idx;
  if (S.nowEl) S.nowEl.classList.remove("now");
  S.nowEl = idx >= 0 ? wordEl(idx) : null;
  if (S.nowEl) {
    S.nowEl.classList.add("now");
    const pan = $(".panels"), r = S.nowEl.getBoundingClientRect(), pr = pan.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom - 60) pan.scrollTo({ top: pan.scrollTop + r.top - pr.top - pr.height / 3, behavior: "smooth" });
  }
}

/* ---------------------------------------------------------------- utilidades de paneles */
function slider(id, label, val, min, max, step, out) { return `<div class="field"><label for="${id}">${label} <output>${out}</output></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`; }
function bindRange(id, fn, out) {
  const el = $("#" + id); if (!el) return;
  let pushed = false;
  el.oninput = () => { if (!pushed) { pushHistory(); pushed = true; } fn(+el.value); if (out) el.previousElementSibling.querySelector("output").textContent = out(+el.value); changed(true); };
  el.onchange = () => (pushed = false);
}
function bindToggle(id, fn) { const el = $("#" + id); if (el) el.onchange = () => { pushHistory(); fn(el.checked); changed(); }; }
const newId = () => Math.random().toString(16).slice(2, 8);

/* ---------------------------------------------------------------- pestaña Clips */
function roleOf(id) {
  if (S.P.timeline.some((t) => t.clip === id)) return "principal";
  if (S.P.broll.some((b) => b.clip === id)) return "apoyo";
  return "fuera";
}
function renderClips() {
  const P = S.P, box = $("#t-clip");
  const list = orderedClips().map((c) => {
    const role = roleOf(c.id), st = !["listo", "sin voz", "sin transcribir"].includes(c.status) ? "procesando…" : `${fmt(c.duration)} · ${c.width}×${c.height} · ${Math.round(c.fps)} fps${c.hdr ? " · HDR" : ""}`;
    return `<div class="clipcard ${S.selClip === c.id ? "on" : ""}" data-clip="${c.id}">
      <img src="/media/${P.id}/file/${c.id}_thumb.jpg" alt="" onerror="this.style.visibility='hidden'">
      <div><b>${esc(c.name)}</b><small><span class="tag ${c.speech ? "voz" : ""}">${c.speech ? "Voz" : "Imagen"}</span><span class="tag">${{ principal: "Principal", apoyo: "Apoyo", fuera: "Sin usar" }[role]}</span>${c.muted ? '<span class="tag">Sin audio</span>' : ""}${st}</small></div></div>`;
  }).join("");
  let det = "";
  const c = S.selClip && clipOf(S.selClip);
  if (c) {
    const role = roleOf(c.id), it = P.timeline.find((t) => t.clip === c.id), b = S.selBroll && P.broll.find((x) => x.id === S.selBroll);
    const adj = c.adjust || {}, cx = c.cropX ?? P.settings.cropX;
    det = `<div class="sec"><h3>${esc(c.name)} <button class="btn small ghost" id="clipClose">Cerrar</button></h3>
      <div class="field"><label>Uso en el video</label><div class="seg" id="roleSeg">
        <button data-v="principal" class="${role === "principal" ? "on" : ""}">Principal</button><button data-v="apoyo" class="${role === "apoyo" ? "on" : ""}">Apoyo encima</button><button data-v="fuera" class="${role === "fuera" ? "on" : ""}">No usar</button></div>
        <p class="fine">${c.speech ? "Tiene voz: como principal se usan su audio y sus subtítulos." : "Sin voz: como principal entra como toma de montaje; como apoyo se ve encima de quien habla."}</p></div>
      <div class="row-f"><label for="speechOn">Tratar como clip con voz</label><input type="checkbox" class="switch" id="speechOn" ${c.speech ? "checked" : ""}></div>
      <div class="row-f"><label for="muteOn">Quitar el audio de este clip</label><input type="checkbox" class="switch" id="muteOn" ${c.muted ? "checked" : ""}></div>`;
    if (role === "principal" && it) {
      det += slider("inR", "Desde", it.in, 0, c.duration, 0.1, fmt(it.in)) + slider("outR", "Hasta", it.out, 0, c.duration, 0.1, fmt(it.out));
      if (!c.speech) det += `<div class="row-f"><label for="fullOn">Usar todo el tramo (sin recortar al ritmo)</label><input type="checkbox" class="switch" id="fullOn" ${it.full ? "checked" : ""}></div>`;
    }
    if (b) {
      det += `<h3 style="margin-top:14px">Esta toma de apoyo <button class="btn small danger" id="brDel">Quitar</button></h3>` +
        slider("brAt", "Aparece en", b.at, 0, Math.max(1, S.plan.total - S.plan.mainStart), 0.1, fmt(b.at)) +
        slider("brDur", "Dura", b.dur, 0.5, Math.max(0.6, c.duration - b.srcIn), 0.1, num(b.dur, 1) + " s") +
        slider("brIn", "Empieza desde el segundo", b.srcIn, 0, Math.max(0, c.duration - 0.5), 0.1, num(b.srcIn, 1) + " s");
    } else if (role === "apoyo") det += `<p class="fine">Elige la toma en la fila «Apoyo» de la línea de tiempo para moverla o cambiar su duración.</p>`;
    if (role === "apoyo") det += `<button class="btn small" id="brAdd">Usarlo otra vez como apoyo en este punto</button>`;
    det += `<h3 style="margin-top:16px">Ajuste de este clip</h3>` +
      slider("cEx", "Exposición", adj.exposure || 0, -1, 1, 0.02, num(adj.exposure || 0)) +
      slider("cTe", "Temperatura", adj.temperature || 0, -1, 1, 0.02, num(adj.temperature || 0)) +
      slider("cSa", "Saturación", adj.saturation || 0, -1, 1, 0.02, num(adj.saturation || 0)) +
      slider("cGain", "Volumen de su audio", c.gain || 0, -12, 12, 1, (c.gain || 0) + " dB") +
      `<div class="field"><label>Encuadre de este clip</label><div class="seg" id="cFit"><button data-v="" class="${!c.fit ? "on" : ""}">Como el proyecto</button><button data-v="llenar" class="${c.fit === "llenar" ? "on" : ""}">Recortar</button><button data-v="difuminado" class="${c.fit === "difuminado" ? "on" : ""}">Difuminado</button></div></div>` +
      slider("cCx", "Mover el encuadre (horizontal)", cx, 0, 1, 0.01, Math.round(cx * 100) + " %") +
      `<button class="btn small danger" id="clipDel" style="margin-top:8px">Eliminar del proyecto</button></div>`;
  }
  box.innerHTML = det + `<div class="sec"><h3>Clips del proyecto <label class="btn small"><input type="file" id="addClips2" accept="video/*" multiple hidden>+ Videos</label></h3><div class="card-list">${list || '<p class="empty-note">Aún no hay clips.</p>'}</div></div>`;
  $("#addClips2").onchange = (e) => { addVideos(e.target.files); e.target.value = ""; };
  $$("#t-clip [data-clip]").forEach((el) => (el.onclick = () => { S.selClip = el.dataset.clip; S.selBroll = null; const itm = S.plan.items.find((i) => i.clip === S.selClip); if (itm) seek(itm.start + 0.01); renderClips(); renderTimeline(); }));
  if (!c) return;
  $("#clipClose").onclick = () => { S.selClip = null; S.selBroll = null; renderClips(); renderTimeline(); };
  $("#roleSeg").onclick = (e) => {
    const bt = e.target.closest("button"); if (!bt) return;
    pushHistory();
    P.timeline = P.timeline.filter((t) => t.clip !== c.id); P.broll = P.broll.filter((x) => x.clip !== c.id); S.selBroll = null;
    if (bt.dataset.v === "principal") P.timeline.push({ clip: c.id, in: 0, out: c.duration });
    if (bt.dataset.v === "apoyo") { const id = newId(); P.broll.push({ id, clip: c.id, at: Math.max(0, S.outT - S.plan.mainStart), dur: Math.min(2.5, c.duration - 0.3), srcIn: 0.3 }); S.selBroll = id; }
    changed();
  };
  $("#speechOn").onchange = (e) => { pushHistory(); c.speech = e.target.checked; changed(); };
  bindToggle("muteOn", (v) => { c.muted = v; activeVideo().muted = activeVideo().dataset.clip === c.id ? v : activeVideo().muted; });
  const it = P.timeline.find((t) => t.clip === c.id), b = S.selBroll && P.broll.find((x) => x.id === S.selBroll);
  if (it) { bindRange("inR", (v) => (it.in = Math.min(v, it.out - 0.3)), fmt); bindRange("outR", (v) => (it.out = Math.max(v, it.in + 0.3)), fmt); }
  bindToggle("fullOn", (v) => (it.full = v));
  if (b) {
    bindRange("brAt", (v) => (b.at = v), fmt); bindRange("brDur", (v) => (b.dur = v), (v) => num(v, 1) + " s"); bindRange("brIn", (v) => (b.srcIn = v), (v) => num(v, 1) + " s");
    $("#brDel").onclick = () => { pushHistory(); P.broll = P.broll.filter((x) => x.id !== b.id); S.selBroll = null; changed(); };
  }
  if ($("#brAdd")) $("#brAdd").onclick = () => { pushHistory(); const id = newId(); P.broll.push({ id, clip: c.id, at: Math.max(0, S.outT - S.plan.mainStart), dur: Math.min(2.5, c.duration - 0.3), srcIn: 0.3 }); S.selBroll = id; changed(); };
  const adj = () => (c.adjust = c.adjust || {});
  bindRange("cEx", (v) => (adj().exposure = v), (v) => num(v)); bindRange("cTe", (v) => (adj().temperature = v), (v) => num(v)); bindRange("cSa", (v) => (adj().saturation = v), (v) => num(v));
  bindRange("cGain", (v) => (c.gain = v), (v) => v + " dB"); bindRange("cCx", (v) => { c.cropX = v; seek(S.outT); }, (v) => Math.round(v * 100) + " %");
  $("#cFit").onclick = (e) => { const bt = e.target.closest("button"); if (!bt) return; pushHistory(); c.fit = bt.dataset.v || undefined; changed(); seek(S.outT); };
  $("#clipDel").onclick = async () => {
    if (!confirm(`¿Eliminar «${c.name}» del proyecto? Se borra la copia guardada en el proyecto.`)) return;
    await flushSave(); S.P = await api("DELETE", `/api/projects/${P.id}/clips/${c.id}`); S.selClip = null; S.selBroll = null; render(); loadProjects();
  };
}

/* ---------------------------------------------------------------- pestaña Color */
function renderColor() {
  const P = S.P, g = P.settings.grade, box = $("#t-color");
  const thumbClip = (S.selClip && clipOf(S.selClip)) || P.clips.find((c) => c.hasVideo !== false);
  const thumb = thumbClip ? `/media/${P.id}/file/${thumbClip.id}_thumb.jpg` : "";
  const looks = Object.entries(S.meta.looks).map(([k, v]) => `<button class="look ${g.look === k ? "on" : ""}" data-look="${k}"><div style="background-image:url(${thumb});filter:${v.css}"></div><span>${v.label}</span></button>`).join("");
  const sl = (k, label) => slider("g_" + k, label, g[k] || 0, k === "vignette" ? 0 : -1, 1, 0.02, num(g[k] || 0));
  box.innerHTML = `<div class="sec"><h3>Look</h3><div class="looks">${looks}</div></div>
    <div class="sec"><h3>Ajustes finos <button class="btn small ghost" id="gReset">Restablecer</button></h3>
    ${sl("exposure", "Exposición")}${sl("contrast", "Contraste")}${sl("saturation", "Saturación")}${sl("temperature", "Temperatura (cálido +)")}${sl("tint", "Tinte (magenta +)")}${sl("vignette", "Viñeta")}</div>
    <div class="sec"><h3>Entre clips</h3><p class="fine">Mide brillo, saturación y temperatura de cada clip y los empareja, como hace un colorista al empezar.</p>
    <button class="btn" id="matchBtn">Igualar color entre clips</button>
    <p class="fine">Cada clip también tiene su propio ajuste en la pestaña Clips.</p></div>
    <p class="fine">La imagen del visor es una aproximación en vivo. «Vista previa final» muestra el color exacto.</p>`;
  $$("#t-color [data-look]").forEach((b) => (b.onclick = () => { pushHistory(); g.look = b.dataset.look; changed(); seek(S.outT); }));
  ["exposure", "contrast", "saturation", "temperature", "tint", "vignette"].forEach((k) => bindRange("g_" + k, (v) => { g[k] = v; const a = activeVideo(); if (a.dataset.clip) a.style.filter = videoFilter(a.dataset.clip); }, (v) => num(v)));
  $("#gReset").onclick = () => { pushHistory(); Object.assign(g, { look: "natural", exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, vignette: 0 }); changed(); seek(S.outT); };
  $("#matchBtn").onclick = async () => { await flushSave(); await api("POST", `/api/projects/${P.id}/match-color`); toast("Midiendo los clips para igualar el color…"); };
}

/* ---------------------------------------------------------------- pestaña Audio */
function renderAudio() {
  const P = S.P, m = P.settings.music, st = P.settings, box = $("#t-audio");
  let mus;
  if (!m.file) mus = `<p class="fine">Arrastra un MP3 o WAV a la ventana, o elígelo aquí. La música baja sola cuando alguien habla.</p>
    <label class="btn primary"><input type="file" id="musIn" accept="audio/*,.mp3,.wav,.m4a" hidden>Elegir música</label>`;
  else mus = `<div class="row-f"><span><b>${esc(m.name)}</b><br><span class="fine">${m.tempo ? Math.round(m.tempo) + " BPM · " : ""}${fmt(m.duration)}</span></span>
      <span><label class="btn small"><input type="file" id="musIn" accept="audio/*" hidden>Cambiar</label> <button class="btn small danger" id="musDel">Quitar</button></span></div>
    ${slider("mVol", "Volumen", m.volume, 0, 1, 0.01, Math.round(m.volume * 100) + " %")}
    <div class="row-f"><label for="mDuck">Bajar la música cuando alguien habla</label><input type="checkbox" class="switch" id="mDuck" ${m.duck ? "checked" : ""}></div>
    <div class="row-f"><label for="mBeat">Cortar las tomas al ritmo</label><input type="checkbox" class="switch" id="mBeat" ${m.beatSync ? "checked" : ""}></div>
    ${slider("mStart", "Empezar la canción desde", m.start, 0, Math.max(1, (m.duration || 60) - 5), 0.5, fmt(m.start))}
    ${slider("mIn", "Entrada suave", m.fadeIn, 0, 5, 0.1, num(m.fadeIn, 1) + " s")}${slider("mOut", "Salida suave", m.fadeOut, 0, 6, 0.1, num(m.fadeOut, 1) + " s")}`;
  const withAudio = P.clips.filter((c) => c.hasAudio);
  const allMuted = withAudio.length && withAudio.every((c) => c.muted);
  const clipAudio = `<div class="sec"><h3>Audio de los videos</h3>
    <div class="row-f"><label for="muteAll">Quitar el audio de todos los videos</label><input type="checkbox" class="switch" id="muteAll" ${allMuted ? "checked" : ""}></div>
    <div class="card-list">${withAudio.map((c) => `<div class="row-f" style="margin:4px 0"><label for="mu_${c.id}" style="font-weight:500">${esc(c.name)}${c.speech ? ' <span class="tag voz">Voz</span>' : ""}</label><input type="checkbox" class="switch" id="mu_${c.id}" ${c.muted ? "" : "checked"} title="Audio activado"></div>`).join("")}</div>
    <p class="fine">Interruptor encendido = se escucha el audio original. Útil para tomas de dron o cámara con viento o ruido.</p></div>`;
  box.innerHTML = `<div class="sec"><h3>Música de fondo</h3>${mus}</div>${clipAudio}
    <div class="sec"><h3>Voz</h3>
    <div class="row-f"><label for="silOn">Quitar silencios</label><input type="checkbox" class="switch" id="silOn" ${st.removeSilences ? "checked" : ""}></div>
    ${slider("pauseR", "Pausa más larga permitida", st.maxPause, 0.1, 1.2, 0.05, num(st.maxPause) + " s")}
    ${slider("padR", "Aire alrededor de cada palabra", st.padding, 0, 0.2, 0.01, num(st.padding) + " s")}
    <p class="fine">Más corta = ritmo más rápido. 0,30 s suena natural para reels.</p></div>`;
  $("#musIn").onchange = (e) => { if (e.target.files[0]) addMusic(e.target.files[0]); };
  if ($("#musDel")) $("#musDel").onclick = async () => { await flushSave(); S.P = await api("DELETE", `/api/projects/${P.id}/music`); render(); };
  bindRange("mVol", (v) => { m.volume = v; m.userVol = true; }, (v) => Math.round(v * 100) + " %");
  bindRange("mStart", (v) => (m.start = v), fmt); bindRange("mIn", (v) => (m.fadeIn = v), (v) => num(v, 1) + " s"); bindRange("mOut", (v) => (m.fadeOut = v), (v) => num(v, 1) + " s");
  bindRange("pauseR", (v) => (st.maxPause = v), (v) => num(v) + " s"); bindRange("padR", (v) => (st.padding = v), (v) => num(v) + " s");
  bindToggle("muteAll", (v) => withAudio.forEach((c) => (c.muted = v)));
  withAudio.forEach((c) => bindToggle("mu_" + c.id, (v) => (c.muted = !v)));
  bindToggle("mDuck", (v) => (m.duck = v)); bindToggle("mBeat", (v) => (m.beatSync = v)); bindToggle("silOn", (v) => (st.removeSilences = v));
}

/* ---------------------------------------------------------------- pestaña Estilo */
function renderEstilo() {
  const P = S.P, st = P.style, s = P.settings, box = $("#t-estilo");
  const kit = S.brands.find((x) => x.id === s.brand);
  const fonts = S.meta.fonts.map((f) => `<option ${st.font === f ? "selected" : ""}>${f}</option>`).join("") + (kit && kit.fontFile ? `<option value="marca" ${st.font === "marca" ? "selected" : ""}>Letra de ${esc(kit.name)}</option>` : "");
  const presets = Object.entries(S.meta.presets).map(([id, p]) => {
    const k = 0.22, em = (FONT_EM[p.font] || .57) * p.size * k;
    const words = (p.uppercase ? "ASÍ SE VE" : "Así se ve").split(" ").map((w, i) => `<span style="color:${p.mode === "progresivo" ? (i < 2 ? p.color : p.color + ";opacity:.44") : i === 1 ? p.highlight : p.color}">${w}</span>`).join(" ");
    return `<button class="preset ${st.preset === id ? "on" : ""}" data-preset="${id}"><span class="pv"><span style="font-family:'${p.font}';font-weight:${p.font === "Poppins" ? 700 : 400};font-size:${em}px;${p.box ? `background:${hexA(p.boxColor, .75)};padding:2px 6px;border-radius:3px;` : `-webkit-text-stroke:${p.outlineWidth * k * 2}px ${p.outline};paint-order:stroke fill;`}">${words}</span></span><span class="pl">${p.label}</span></button>`;
  }).join("");
  const j = S.selJunction, itm = j != null && S.plan.items[j];
  const tr = s.transition;
  const tl = itm && itm.kind === "clip" ? P.timeline[itm.ti] : null;
  const active = itm ? (tl && tl.transition && tl.transition.type) || null : tr.type;
  const mixed = !itm && P.timeline.some((t) => t.transition);
  const transBtns = (itm ? "" : `<button data-t="variado" class="${mixed ? "on" : ""}" title="Una distinta en cada unión, al ritmo de la música">Variadas ♪</button>`)
    + Object.keys(TRANS_LABEL).map((k) => `<button data-t="${k}" class="${!mixed && active === k ? "on" : ""}">${TRANS_LABEL[k]}</button>`).join("");
  const itmName = itm ? (itm.kind === "clip" ? (clipOf(itm.clip) || {}).name : itm.card === "intro" ? "la intro" : "el cierre") : "";
  box.innerHTML = `<div class="sec"><h3>Transiciones ${itm ? `<button class="btn small ghost" id="jClose">Ver la general</button>` : ""}</h3>
      <p class="fine">${itm ? `Solo la unión antes de «${esc(itmName)}» (ahora: ${TRANS_LABEL[itm.ttype]}). ${tl && tl.transition ? '<a href="#" id="jReset">Usar la general</a>' : ""}` : "Se aplica entre clips. Los saltos dentro de un mismo clip (silencios quitados) siempre son cortes. Para cambiar una sola unión, toca su ◆ en la línea de tiempo."}</p>
      <div class="trans" id="transGrid">${transBtns}</div>
      ${slider("tDur", "Duración", tr.dur, 0.1, 1.5, 0.05, num(tr.dur) + " s")}</div>
    <div class="sec"><h3>Ritmo de las tomas</h3>${slider("paceR", "Duración de cada toma de montaje o apoyo", s.pace, 0.6, 6, 0.1, num(s.pace, 1) + " s")}</div>
    <div class="sec"><h3>Subtítulos <input type="checkbox" class="switch" id="subsOn" ${s.subtitles ? "checked" : ""}></h3>
      <div class="presets">${presets}</div>
      <div class="field"><label>Letra</label><select id="fontSel">${fonts}</select></div>
      ${slider("sizeR", "Tamaño", st.size, 40, 220, 2, st.size)}
      <div class="field"><label>Colores</label><div class="swatches">
        <label class="sw"><input type="color" id="cText" value="${st.color}">Texto</label><label class="sw"><input type="color" id="cHi" value="${st.highlight}">Resaltado</label>
        <label class="sw ${st.box ? "off" : ""}"><input type="color" id="cOl" value="${st.outline}">Borde</label><label class="sw ${st.box ? "" : "off"}"><input type="color" id="cBox" value="${st.boxColor || "#111111"}">Caja</label></div></div>
      <div class="field"><label>Posición</label><div class="seg" id="posSeg">${["arriba", "centro", "abajo"].map((v) => `<button data-v="${v}" class="${st.position === v ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div></div>
      ${slider("wordsR", "Palabras por pantalla", st.maxWords, 1, 8, 1, st.maxWords)}
      <div class="row-f"><label for="upOn">Mayúsculas</label><input type="checkbox" class="switch" id="upOn" ${st.uppercase ? "checked" : ""}></div>
      <div class="row-f"><label for="boxOn">Caja detrás del texto</label><input type="checkbox" class="switch" id="boxOn" ${st.box ? "checked" : ""}></div>
      ${slider("olR", "Grosor del borde", st.outlineWidth, 0, 14, 1, st.outlineWidth)}</div>`;
  if ($("#jClose")) $("#jClose").onclick = () => { S.selJunction = null; renderTimeline(); renderEstilo(); };
  if ($("#jReset")) $("#jReset").onclick = (e) => { e.preventDefault(); pushHistory(); delete tl.transition; changed(); };
  $("#transGrid").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    pushHistory();
    if (b.dataset.t === "variado") {
      flushSave().then(() => api("POST", `/api/projects/${P.id}/vary`, {})).then((np) => { S.P = np; render(); toast("Transiciones variadas al ritmo de la música"); }).catch((er) => toast(er.message, 4000));
      return;
    }
    if (itm && tl) tl.transition = { type: b.dataset.t };
    else { tr.type = b.dataset.t; P.timeline.forEach((t) => delete t.transition); } // la general vale para todas
    changed();
  };
  bindToggle("subsOn", (v) => (s.subtitles = v));
  $$("#t-estilo [data-preset]").forEach((b) => (b.onclick = () => { pushHistory(); const p = { ...S.meta.presets[b.dataset.preset] }; delete p.label; delete p.desc; P.style = { ...p, preset: b.dataset.preset }; changed(); }));
  bindRange("tDur", (v) => (tr.dur = v), (v) => num(v) + " s"); bindRange("paceR", (v) => (s.pace = v), (v) => num(v, 1) + " s");
  bindRange("sizeR", (v) => (st.size = v), (v) => v); bindRange("wordsR", (v) => (st.maxWords = v), (v) => v); bindRange("olR", (v) => (st.outlineWidth = v), (v) => v);
  const col = (id, k) => { const el = $("#" + id); let pu = false; el.oninput = () => { if (!pu) { pushHistory(); pu = true; } st[k] = el.value.toUpperCase(); changed(true); }; el.onchange = () => (pu = false); };
  col("cText", "color"); col("cHi", "highlight"); col("cOl", "outline"); col("cBox", "boxColor");
  $("#fontSel").onchange = (e) => { pushHistory(); st.font = e.target.value; changed(); };
  $("#posSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; pushHistory(); st.position = b.dataset.v; changed(); };
  bindToggle("upOn", (v) => (st.uppercase = v)); bindToggle("boxOn", (v) => (st.box = v));
}

/* ---------------------------------------------------------------- pestaña Marca */
function renderMarca() {
  const P = S.P, s = P.settings, box = $("#t-marca");
  const kitId = S.editBrand || s.brand, kit = S.brands.find((x) => x.id === kitId);
  const opts = `<option value="">Sin línea gráfica</option>` + S.brands.map((k) => `<option value="${k.id}" ${s.brand === k.id ? "selected" : ""}>${esc(k.name)}</option>`).join("");
  let editor = "";
  if (kit) {
    const c = kit.colors;
    editor = `<div class="sec"><h3>Editar «${esc(kit.name)}» <button class="btn small danger" id="kDel">Borrar</button></h3>
      <div class="field"><label>Nombre</label><input class="textin" id="kName" value="${esc(kit.name)}"></div>
      <div class="field"><label>Colores</label><div class="swatches">
        <label class="sw"><input type="color" data-k="primary" value="${c.primary}">Fondo</label><label class="sw"><input type="color" data-k="text" value="${c.text}">Texto</label>
        <label class="sw"><input type="color" data-k="accent" value="${c.accent}">Acento</label><label class="sw"><input type="color" data-k="secondary" value="${c.secondary}">Secundario</label></div></div>
      <div class="field"><label>Logo</label><div class="logo-prev" style="${kit.logo ? `background-image:url(/brand/${kit.id}/logo.png?${kit.logoV || ""})` : ""}">${kit.logo ? "" : "PNG con fondo transparente"}</div>
        <label class="btn small" style="margin-top:6px"><input type="file" id="kLogo" accept="image/png,image/jpeg,image/webp" hidden>${kit.logo ? "Cambiar logo" : "Subir logo"}</label></div>
      <div class="field"><label>Letra de la marca</label><p class="fine">${kit.fontFile ? `Usando «${esc(kit.fontName)}».` : "Sube el archivo .ttf u .otf de la tipografía de la marca."}</p>
        <label class="btn small"><input type="file" id="kFont" accept=".ttf,.otf" hidden>${kit.fontFile ? "Cambiar letra" : "Subir letra"}</label></div>
      <button class="btn small" id="kCaps">Usar estos colores en los subtítulos</button></div>`;
  }
  const lg = s.logo;
  box.innerHTML = `<div class="sec"><h3>Línea gráfica del proyecto</h3><select id="kSel">${opts}</select>
      <p class="fine">Las líneas gráficas se guardan aparte y sirven para todos los proyectos (por ejemplo, una por cliente).</p></div>
    ${s.brand ? `<div class="sec"><h3>Logo en el video <input type="checkbox" class="switch" id="lgOn" ${lg.on ? "checked" : ""}></h3>
      <div class="field"><label>Posición</label><select id="lgPos">${["arriba-izquierda", "arriba-centro", "arriba-derecha", "abajo-izquierda", "abajo-centro", "abajo-derecha"].map((v) => `<option value="${v}" ${lg.pos === v ? "selected" : ""}>${v.replace("-", " ")}</option>`).join("")}</select></div>
      ${slider("lgSize", "Tamaño", lg.size, 0.05, 0.4, 0.01, Math.round(lg.size * 100) + " %")}${slider("lgOp", "Opacidad", lg.opacity, 0.2, 1, 0.05, Math.round(lg.opacity * 100) + " %")}</div>` : ""}
    <div class="sec"><h3>Intro <input type="checkbox" class="switch" id="inOn" ${s.intro.on ? "checked" : ""}></h3>
      <input class="textin" id="inText" placeholder="Título (opcional)" value="${esc(s.intro.text)}">${slider("inDur", "Duración", s.intro.dur, 1, 5, 0.5, num(s.intro.dur, 1) + " s")}</div>
    <div class="sec"><h3>Cierre <input type="checkbox" class="switch" id="outOn" ${s.outro.on ? "checked" : ""}></h3>
      <input class="textin" id="outText" placeholder="Ej.: Síguenos para más" value="${esc(s.outro.text)}">${slider("outDur", "Duración", s.outro.dur, 1, 6, 0.5, num(s.outro.dur, 1) + " s")}</div>
    ${editor}
    <button class="btn small" id="kNew">+ Nueva línea gráfica</button>`;
  $("#kSel").onchange = (e) => { pushHistory(); s.brand = e.target.value; S.editBrand = e.target.value || null; if (s.brand && !lg.on) lg.on = true; changed(); };
  bindToggle("lgOn", (v) => (lg.on = v)); bindToggle("inOn", (v) => (s.intro.on = v)); bindToggle("outOn", (v) => (s.outro.on = v));
  if ($("#lgPos")) $("#lgPos").onchange = (e) => { pushHistory(); lg.pos = e.target.value; changed(); };
  bindRange("lgSize", (v) => (lg.size = v), (v) => Math.round(v * 100) + " %"); bindRange("lgOp", (v) => (lg.opacity = v), (v) => Math.round(v * 100) + " %");
  bindRange("inDur", (v) => (s.intro.dur = v), (v) => num(v, 1) + " s"); bindRange("outDur", (v) => (s.outro.dur = v), (v) => num(v, 1) + " s");
  $("#inText").onchange = (e) => { pushHistory(); s.intro.text = e.target.value; if (e.target.value) s.intro.on = true; changed(); };
  $("#outText").onchange = (e) => { pushHistory(); s.outro.text = e.target.value; if (e.target.value) s.outro.on = true; changed(); };
  $("#kNew").onclick = () => $('#brandList [data-brand="__new"]').click();
  if (!kit) return;
  const saveKit = async () => { const k = await api("PUT", "/api/brands/" + kit.id, kit); Object.assign(kit, k); renderBrands(); S.capKey = null; seek(S.outT); };
  $("#kName").onchange = (e) => { kit.name = e.target.value || kit.name; saveKit(); };
  $$("#t-marca [data-k]").forEach((el) => (el.onchange = () => { kit.colors[el.dataset.k] = el.value.toUpperCase(); saveKit(); }));
  $("#kLogo").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { Object.assign(kit, await upload(`/api/brands/${kit.id}/logo?filename=${encodeURIComponent(f.name)}`, f)); kit.logoV = Date.now(); renderBrands(); renderMarca(); drawFrame(); } catch (x) { toast(x.message, 5000); } };
  $("#kFont").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { Object.assign(kit, await upload(`/api/brands/${kit.id}/font?filename=${encodeURIComponent(f.name)}`, f)); renderMarca(); toast("Letra cargada. Elígela en Estilo → Letra."); } catch (x) { toast(x.message, 5000); } };
  $("#kCaps").onclick = () => { pushHistory(); const st = P.style; st.highlight = kit.colors.accent; st.color = kit.colors.text; st.boxColor = kit.colors.primary; st.outline = kit.colors.primary; if (kit.fontFile) st.font = "marca"; changed(); toast("Subtítulos con los colores de la marca."); };
  $("#kDel").onclick = async () => { if (!confirm(`¿Borrar la línea gráfica «${kit.name}»?`)) return; await api("DELETE", "/api/brands/" + kit.id); if (s.brand === kit.id) { s.brand = ""; changed(); } S.editBrand = null; await loadBrands(); renderMarca(); };
}

/* ---------------------------------------------------------------- pestaña Formato */
const MAXDUR = [[0, "Sin límite"], [15, "15 s"], [30, "30 s"], [45, "45 s"], [60, "1 min"], [90, "1:30"], [180, "3 min"]];
const fmtDur = (v) => (+v ? (v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")} min` : `${v} s`) : "Sin límite");
function maxDurSeg(id, cur) {
  cur = +cur || 0;
  return `<div class="maxdur" id="${id}"><div class="md-top"><b class="md-val">${fmtDur(cur)}</b><label class="md-type">Escribe: <input class="md-in textin" inputmode="numeric" placeholder="m:ss" value="${cur ? Math.floor(cur / 60) + ":" + String(cur % 60).padStart(2, "0") : ""}" aria-label="Escribir la duración, por ejemplo 1:40"></label></div>
    <input type="range" min="0" max="180" step="1" value="${cur}" aria-label="Duración máxima">
    <div class="md-chips">${MAXDUR.map(([v, l]) => `<button type="button" data-v="${v}" class="${cur === v ? "on" : ""}">${l}</button>`).join("")}</div></div>`;
}
function setMaxDur(box, v, commit) {
  v = Math.round(+v || 0); if (v > 0 && v < 5) v = 5;
  box.querySelector(".md-val").textContent = fmtDur(v);
  box.querySelector("input[type=range]").value = Math.min(v, 180);
  const ti = box.querySelector(".md-in"); if (ti && document.activeElement !== ti) ti.value = v ? Math.floor(v / 60) + ":" + String(v % 60).padStart(2, "0") : "";
  box.querySelectorAll(".md-chips button").forEach((b) => b.classList.toggle("on", +b.dataset.v === v));
  if (!S.P) return;
  S.P.settings.maxDur = v;
  if (commit) { if (box.id === "maxSeg") { changed(); seek(Math.min(S.outT, S.plan.total)); } else scheduleSave(); }
}
document.addEventListener("input", (e) => { const box = e.target.closest(".maxdur"); if (box && e.target.type === "range") setMaxDur(box, e.target.value, false); });
document.addEventListener("change", (e) => { const box = e.target.closest(".maxdur"); if (box && e.target.type === "range") { pushHistory(); setMaxDur(box, e.target.value, true); } });
function parseDur(t) {
  t = String(t || "").trim().replace(",", ".").replace(/\s*(min|m|s|seg)\s*$/i, "");
  if (!t) return 0;
  if (t.includes(":")) { const [m, s] = t.split(":"); return (+m || 0) * 60 + (+s || 0); }
  return Math.round(+t) || 0;
}
document.addEventListener("keydown", (e) => { if (e.target.classList && e.target.classList.contains("md-in") && e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
document.addEventListener("focusout", (e) => {
  if (!e.target.classList || !e.target.classList.contains("md-in")) return;
  const v = Math.min(3600, parseDur(e.target.value)); pushHistory(); setMaxDur(e.target.closest(".maxdur"), v, true);
  e.target.value = v ? Math.floor(v / 60) + ":" + String(v % 60).padStart(2, "0") : "";
});
document.addEventListener("click", (e) => { const b = e.target.closest(".maxdur .md-chips button"); if (b) { pushHistory(); setMaxDur(b.closest(".maxdur"), b.dataset.v, true); } });
function fmtShort(k) { return k === "vertical" ? "9:16" : k === "horizontal" ? "16:9" : k === "cuadrado" ? "1:1" : k; }
function renderFormato() {
  const P = S.P, s = P.settings, box = $("#t-formato");
  const desc = { vertical: "Reels, TikTok", horizontal: "YouTube", "4:5": "Feed", "5:4": "Feed horizontal", cuadrado: "Cuadrado" };
  const fm = Object.entries(S.meta.formats).map(([k, f]) => `<button data-f="${k}" class="${s.format === k ? "on" : ""}"><i style="width:${Math.round(24 * f.w / f.h)}px"></i><b>${fmtShort(k)}</b><span>${desc[k]}</span></button>`).join("");
  const G = geom(), mixed = P.clips.some((c) => c.width && Math.abs(c.width / c.height - G.W / G.H) > 0.01);
  box.innerHTML = `<div class="sec"><h3>Duración máxima</h3>${maxDurSeg("maxSeg", s.maxDur)}<p class="fine">Si el video queda más largo, se recorta al final (la intro y el cierre se respetan).</p></div>
    <div class="sec"><div class="row-f"><label for="punchOn"><b>Acercamiento en los cortes</b><span class="fine" style="display:block;margin:0">Cuando se corta dentro de un mismo video, alterna un zoom leve para que el salto se vea intencional.</span></label><input type="checkbox" class="switch" id="punchOn" ${s.punchIn !== false ? "checked" : ""}></div></div>
    <div class="sec"><h3>Formato del video</h3><div class="formats" id="fmtGrid">${fm}</div>
      <p class="fine">La resolución (720p, 1080p, 2K o 4K) y los fotogramas (24, 30 o 60) se eligen al exportar.</p></div>
    ${mixed ? `<div class="sec"><h3>Clips con otra forma</h3><div class="field"><label>Cómo encajan</label><div class="seg" id="fitSeg"><button data-v="llenar" class="${s.fit === "llenar" ? "on" : ""}">Recortar</button><button data-v="difuminado" class="${s.fit === "difuminado" ? "on" : ""}">Fondo difuminado</button></div></div>
      ${slider("cxR", "Mover el encuadre (horizontal)", s.cropX, 0, 1, 0.01, Math.round(s.cropX * 100) + " %")}${slider("cyR", "Mover el encuadre (vertical)", s.cropY, 0, 1, 0.01, Math.round(s.cropY * 100) + " %")}
      <p class="fine">Cada clip puede tener su propio encuadre en la pestaña Clips.</p></div>` : ""}
    <div class="sec"><h3>Tus clips</h3>${P.clips.map((c) => `<p class="fine">«${esc(c.name)}»: ${c.width || "?"}×${c.height || "?"} · ${c.fps ? Math.round(c.fps) : "?"} fps${c.hdr ? " · HDR" : ""}</p>`).join("") || '<p class="fine">Sin clips todavía.</p>'}</div>`;
  $("#punchOn").onchange = (e) => { pushHistory(); s.punchIn = e.target.checked; changed(); };
  $("#fmtGrid").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; pushHistory(); s.format = b.dataset.f; changed(); sizeScreen(); seek(S.outT); };
  if ($("#fitSeg")) $("#fitSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; pushHistory(); s.fit = b.dataset.v; changed(); seek(S.outT); };
  bindRange("cxR", (v) => { s.cropX = v; seek(S.outT); }, (v) => Math.round(v * 100) + " %");
  bindRange("cyR", (v) => { s.cropY = v; seek(S.outT); }, (v) => Math.round(v * 100) + " %");
}

/* ---------------------------------------------------------------- pestaña Referencia */
function renderRef() {
  const P = S.P, ref = P.reference, box = $("#t-ref");
  if (!ref) {
    box.innerHTML = `<div class="tip">Sube un video que te guste (un reel de otra cuenta, un anuncio, un video de un filmmaker). Reel Studio mide su ritmo de cortes, su color y su formato, y puede aplicarlos a tu proyecto.</div>
      <label class="btn primary"><input type="file" id="refIn" accept="video/*" hidden>Subir video de referencia</label>`;
    $("#refIn").onchange = (e) => e.target.files[0] && addReference(e.target.files[0]);
    return;
  }
  const a = ref.analysis;
  box.innerHTML = `<div class="sec"><h3>${esc(ref.name || "Referencia")} <span><label class="btn small"><input type="file" id="refIn" accept="video/*" hidden>Cambiar</label> <button class="btn small danger" id="refDel">Quitar</button></span></h3>
    <video src="/media/${P.id}/reference" controls playsinline style="width:100%;max-height:240px;border-radius:12px;background:#000"></video></div>
    ${a ? `<img class="refsheet" src="/media/${P.id}/file/ref_sheet.jpg?${a.shots}" alt="Fotogramas de la referencia">
    <div class="facts">
      <div class="fact"><b>${a.shots}</b><small>tomas en ${fmt(a.duration)}</small></div>
      <div class="fact"><b>${num(a.avgShot, 1)} s</b><small>dura cada toma (promedio)</small></div>
      <div class="fact"><b>${S.meta.looks[a.look].label}</b><small>look de color parecido</small></div>
      <div class="fact"><b>${fmtShort(a.format)}</b><small>${a.width}×${a.height}${a.tempo ? ` · ${Math.round(a.tempo)} BPM` : ""}</small></div></div>
    <button class="btn wide" id="refApply">Aplicar solo el estilo (automático)</button>
    <p class="fine">Cambia formato, duración de las tomas, transición y color. Se puede deshacer con ⌘Z.</p>`
    : `<p class="fine">Analizando la referencia…</p>`}
    <div class="sec" style="margin-top:16px"><h3>Cómo quieres tu video</h3>
      <p class="fine">Describe qué armar con tus clips usando esta referencia como guía. Claude lo lee junto con la referencia y arma el video.</p>
      <textarea id="refPrompt" placeholder="Ej.: un reel de 30 s para el cliente, empieza con la toma de dron más llamativa, ritmo rápido como la referencia, el texto clave en el segundo 3 y cierra con el logo">${esc(ref.prompt || "")}</textarea>
      <button class="btn primary wide" id="refSend" style="margin-top:8px">Armar con la referencia y estas instrucciones</button>
      <p class="fine">Luego dile a Claude en el chat: <b>«revisa mis pedidos de Reel Studio»</b>.</p></div>`;
  $("#refPrompt").oninput = (e) => { ref.prompt = e.target.value; scheduleSave(); };
  $("#refSend").onclick = async () => {
    const t = $("#refPrompt").value.trim();
    if (!t) { toast("Escribe primero cómo quieres el video."); return; }
    await flushSave();
    S.P = await api("POST", `/api/projects/${P.id}/requests`, { text: t, kind: "referencia" });
    render(); toast("Listo. Ahora dile a Claude: «revisa mis pedidos de Reel Studio».", 5000);
  };
  $("#refIn").onchange = (e) => e.target.files[0] && addReference(e.target.files[0]);
  $("#refDel").onclick = async () => { await flushSave(); S.P = await api("DELETE", `/api/projects/${P.id}/reference`); render(); };
  if ($("#refApply")) $("#refApply").onclick = async () => { await flushSave(); pushHistory(); S.P = await api("POST", `/api/projects/${P.id}/apply-reference`); render(); seek(S.outT); toast("Apliqué el estilo de la referencia."); };
}

/* ---------------------------------------------------------------- pestaña Pedidos */
function renderPedidos() {
  const P = S.P, box = $("#t-pedidos");
  const list = (P.requests || []).slice().reverse().map((r) => `<div class="req ${r.status === "hecho" ? "done" : ""}"><span class="st">${r.status === "hecho" ? "Hecho" : "Pendiente"}</span> · <span class="fine" style="margin:0">${new Date(r.t * 1000).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
    <div>${esc(r.text)}</div>${r.note ? `<div class="note">Claude: ${esc(r.note)}</div>` : ""}</div>`).join("");
  box.innerHTML = `<div class="tip">Escribe lo que quieres cambiar como se lo dirías a un editor. Luego dile a Claude en el chat: <b>«revisa mis pedidos de Reel Studio»</b>. Los cambios aparecen aquí solos.</div>
    <textarea id="reqText" placeholder="Ej.: quita la parte donde me equivoco al inicio, pon más tomas de dron entre el segundo 10 y 20, y que el color se parezca a la referencia"></textarea>
    <button class="btn primary" id="reqGo" style="margin-top:8px">Guardar pedido</button>
    <div class="card-list" style="margin-top:14px">${list}</div>`;
  $("#reqGo").onclick = async () => {
    const t = $("#reqText").value.trim(); if (!t) return;
    await flushSave(); S.P = await api("POST", `/api/projects/${P.id}/requests`, { text: t }); render(); toast("Pedido guardado para Claude.");
  };
}

/* ---------------------------------------------------------------- pestaña Actividad */
function renderLog() {
  const L = (S.P.log || []).slice().reverse();
  $("#t-log").innerHTML = `<ol class="log">${L.map((x) => `<li><span class="who ${x.who === "claude" ? "claude" : ""}">${x.who === "claude" ? "Claude" : "Auto"}</span><span>${esc(x.text)}<span class="lt">${new Date(x.t * 1000).toLocaleString("es", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</span></span></li>`).join("") || '<li><span></span><span class="fine">Aquí verás lo que cambian la limpieza automática y Claude.</span></li>'}</ol>`;
}

/* ---------------------------------------------------------------- armar y exportar */
$("#assembleBtn").addEventListener("click", async () => {
  if (!S.P) return;
  if (S.P.timeline.length > 1 && !confirm("¿Armar el video de nuevo? Se reordenan los clips y se recolocan las tomas de apoyo (se puede deshacer con ⌘Z).")) return;
  await flushSave(); pushHistory();
  S.P = await api("POST", `/api/projects/${S.P.id}/assemble`);
  render(); seek(0);
  const L = S.P.log || []; if (L.length) toast(L[L.length - 1].text, 4000);
});
$("#exportBtn").addEventListener("click", async () => {
  if (!S.P) return;
  await flushSave();
  const P = await api("GET", "/api/projects/" + S.P.id);
  const maxFps = Math.max(...S.P.clips.map((c) => c.fps || 30));
  if (!S.exp || S.exp.pid !== S.P.id) S.exp = { pid: S.P.id, res: 1080, fps: maxFps >= 49 ? 60 : maxFps < 26 ? 24 : 30, quality: "alta", codec: "h264" };
  S.exp.format = S.P.settings.format;
  $("#eSubs").checked = !!S.P.settings.subtitles;
  $("#expOpts").hidden = false; $("#expProg").hidden = true; $("#expDone").hidden = true; $("#expGo").hidden = false;
  $("#eFmt").innerHTML = Object.keys(S.meta.formats).map((k) => `<button type="button" data-v="${k}">${fmtShort(k)}</button>`).join("");
  renderExpOpts(); renderExports(P.exports || []);
  $("#exportDlg").showModal();
});
function renderExpOpts() {
  const E = S.exp, P = S.P, G = geom(E.format), m = E.res / 1080, W = Math.round(G.W * m / 2) * 2, H = Math.round(G.H * m / 2) * 2;
  const mark = (sel, v) => $$(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
  mark("#eFmt", E.format); mark("#eRes", E.res); mark("#eFps", E.fps); mark("#eQ", E.quality); mark("#eCodec", E.codec);
  const maxSide = Math.max(0, ...P.clips.map((c) => Math.min(c.width || 0, c.height || 0))), maxFps = Math.max(30, ...P.clips.map((c) => c.fps || 30));
  $("#resNote").innerHTML = E.res > maxSide + 8 ? `<span class="warn">Tus clips llegan a ${maxSide}p: exportar a más resolución no agrega detalle, solo peso.</span>` : "";
  $("#fpsNote").innerHTML = E.fps > maxFps + 1 ? `<span class="warn">Tus clips están a ${Math.round(maxFps)} fps: a ${E.fps} no se verá más fluido.</span>` : `Tus clips: hasta ${Math.round(maxFps)} fps.`;
  const hdr = P.clips.length && P.clips.every((c) => c.hdr) && P.settings.grade.look === "natural";
  $("#codecNote").textContent = E.codec === "prores" ? "Archivo .mov muy pesado, sin pérdida visible: para seguir en Premiere, Final Cut o DaVinci." : hdr ? "Tus clips son HDR: sale en HEVC 10-bit HDR para conservar el brillo del iPhone." : "MP4 listo para Instagram, TikTok y YouTube.";
  $("#expInfo").textContent = `Duración ${fmt(S.plan.total)} · ${G.label} · ${W}×${H} · ${E.fps} fps`;
  $("#expGo").textContent = `Exportar ${E.codec === "prores" ? "MOV" : "MP4"} ${W}×${H}`;
}
[["#eFmt", "format", String], ["#eRes", "res", Number], ["#eFps", "fps", Number], ["#eQ", "quality", String], ["#eCodec", "codec", String]].forEach(([sel, key, conv]) => {
  $(sel).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.exp[key] = conv(b.dataset.v); renderExpOpts(); });
});
$("#expGo").addEventListener("click", async () => {
  const id = S.P.id, E = S.exp;
  const opts = { format: E.format, res: E.res, fps: E.fps, quality: E.quality, codec: E.codec, subtitles: $("#eSubs").checked, srt: $("#eSrt").checked, loudnorm: $("#eLoud").checked };
  $("#expOpts").hidden = true; $("#expProg").hidden = false; $("#expGo").hidden = true; $("#expBar").style.width = "0%";
  let j0;
  try { j0 = await api("POST", `/api/projects/${id}/export`, opts); } catch (e) { toast(e.message, 6000); $("#expOpts").hidden = false; $("#expGo").hidden = false; return; }
  for (;;) {
    const j = await api("GET", "/api/jobs/" + j0.id);
    $("#expBar").style.width = (j.progress * 100).toFixed(1) + "%";
    $("#expMsg").textContent = `${j.message} ${Math.round(j.progress * 100)} %`;
    if (j.status === "done") {
      $("#expProg").hidden = true; $("#expDone").hidden = false;
      $("#expDone").textContent = `Listo: ${j.result.size_px} · ${j.result.fps} fps · ${j.result.codec} · ${(j.result.size / 1e6).toFixed(1)} MB`;
      const P = await api("GET", "/api/projects/" + id); renderExports(P.exports || []);
      break;
    }
    if (j.status === "error") { $("#expProg").hidden = true; $("#expOpts").hidden = false; $("#expGo").hidden = false; toast("No se pudo exportar: " + j.error, 9000); break; }
    await sleep(700);
  }
});
function renderExports(list) {
  const id = S.P.id;
  const root = (S.meta.exportsRoot || "").replace(/^.*\/(Movies|Videos)\//, (m, a) => (a === "Movies" ? "Películas" : "Videos") + " › ").replace(/\//g, " › ");
  const where = `<p class="fine where">Se guardan en <b>${esc(root)} › ${esc(S.P.name)}</b></p>`;
  $("#expList").innerHTML = where + (list.length ? `<p class="fine">Exportaciones de este proyecto</p>` : "") + list.map((f) => `<div class="ex"><span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span>
    <a href="/media/${id}/export/${encodeURIComponent(f.name)}?dl=1">Descargar</a> · <a href="#" data-reveal="${esc(f.name)}">Mostrar en Finder</a></span></div>`).join("");
}
$("#expList").addEventListener("click", (e) => { const b = e.target.closest("[data-reveal]"); if (b) { e.preventDefault(); api("POST", `/api/projects/${S.P.id}/reveal`, { file: b.dataset.reveal }); } });

/* ---------------------------------------------------------------- varios */
$("#projTitle").addEventListener("change", (e) => { if (!S.P) return; S.P.name = e.target.value.trim() || "Proyecto"; scheduleSave(); setTimeout(loadProjects, 900); });
$("#undoBtn").addEventListener("click", undo);
$("#redoBtn").addEventListener("click", redo);
function clearSelection() {
  setSel(null); S.selJunction = null; S.selClip = null; S.selBroll = null; S.selAnim = null;
  renderTimeline(); if (S.tab === "t-clip") renderClips(); if (S.tab === "t-color") renderColor(); if (S.tab === "t-anim") renderAnim();
}
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  // Escape siempre suelta la selección (aunque el foco esté en un control deslizante o un botón)
  if (e.key === "Escape" && S.P && !document.querySelector("dialog[open]")) {
    const typing = tag === "textarea" || (tag === "input" && /^(text|search|number|)$/.test(e.target.type || ""));
    if (typing) { e.target.blur(); return; }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    clearSelection(); return;
  }
  if (["input", "select", "textarea"].includes(tag) || document.querySelector("dialog[open]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (!S.P) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
  if ((e.key === "Backspace" || e.key === "Delete") && S.sel && S.tab === "t-texto") { e.preventDefault(); const idx = rangeIdx(); setCut(idx, !idx.every((i) => S.P.words[i].cut)); return; }
  if ((e.key === "Backspace" || e.key === "Delete") && (S.selBroll || S.selAnim || S.selClip)) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === "ArrowLeft" && !S.sel) seek(S.outT - (e.shiftKey ? 5 : 1 / 3));
  if (e.key === "ArrowRight" && !S.sel) seek(S.outT + (e.shiftKey ? 5 : 1 / 3));
});
window.addEventListener("hashchange", () => openProject(location.hash.slice(1)));
window.addEventListener("beforeunload", () => { if (S.dirty) save(); });

/* actualizaciones: se revisan solas y avisan con un botón; un toque y se instala con animación */
let updInfo = null, updDismissed = "";
async function checkUpdate() {
  try {
    const u = await api("GET", "/api/update");
    updInfo = u.available ? u : null;
    const b = $("#updateBtn"); b.hidden = !u.available;
    if (u.available) b.title = "Hay mejoras y novedades";
    showUpdPill();
  } catch (_) {}
}
function showUpdPill() {
  let pill = $("#updPill");
  if (!updInfo || updDismissed === updInfo.latest || document.body.classList.contains("updating")) { if (pill) pill.classList.remove("show"); return; }
  if (!pill) {
    pill = document.createElement("div"); pill.id = "updPill"; pill.className = "updpill glass";
    pill.innerHTML = '<span class="upd-dot"></span><div class="upd-txt"><b>Hay una versión nueva</b><span id="updMsg"></span></div>' +
      '<button class="btn primary small" id="updGo">Actualizar</button><button class="upd-x" id="updLater" aria-label="Más tarde">×</button>';
    document.body.appendChild(pill);
    $("#updGo").addEventListener("click", () => openUpdDlg(updInfo));
    $("#updLater").addEventListener("click", () => { updDismissed = updInfo ? updInfo.latest : ""; pill.classList.remove("show"); });
  }
  $("#updMsg").textContent = "Mejoras y novedades. Toca para instalarla en segundos.";
  requestAnimationFrame(() => pill.classList.add("show"));
}
async function runUpdate() {
  if (document.body.classList.contains("updating")) return;
  document.body.classList.add("updating"); showUpdPill();
  const ov = document.createElement("div"); ov.className = "updov";
  ov.innerHTML = '<div class="upd-card glass"><div class="upd-orb"><img src="/static/logo.svg" alt=""><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" class="trk"/><circle cx="60" cy="60" r="54" class="arc" id="updArc"/></svg></div>' +
    '<h2>Actualizando Reel Studio</h2><p id="updStep">Guardando tu trabajo…</p><ol class="upd-steps"><li class="on">Guardar</li><li>Descargar</li><li>Instalar</li><li>Abrir</li></ol></div>';
  document.body.appendChild(ov); requestAnimationFrame(() => ov.classList.add("show"));
  const arc = ov.querySelector("#updArc"), steps = ov.querySelectorAll(".upd-steps li");
  let pct = 0, target = 8;
  const tick = setInterval(() => { pct += (target - pct) * 0.08; arc.style.strokeDashoffset = 339.3 * (1 - pct / 100); }, 30);
  const step = (i, txt, t) => { steps.forEach((s, k) => { s.classList.toggle("on", k === i); s.classList.toggle("done", k < i); }); $("#updStep").textContent = txt; target = t; };
  const fail = (msg) => { clearInterval(tick); ov.classList.add("err"); $("#updStep").textContent = msg;
    const c = document.createElement("button"); c.className = "btn small"; c.textContent = "Cerrar"; ov.querySelector(".upd-card").appendChild(c);
    c.onclick = () => { ov.remove(); document.body.classList.remove("updating"); showUpdPill(); }; };
  try {
    await flushSave();
    step(1, "Descargando la versión nueva…", 55);
    const r = await api("POST", "/api/update");
    if (!r.updated) { step(3, "Ya tienes la última versión.", 100); updInfo = null; $("#updateBtn").hidden = true; await sleep(900); ov.remove(); document.body.classList.remove("updating"); return; }
    step(2, "Instalando mejoras…", 85);
    await sleep(600);
    step(3, "Abriendo la versión nueva…", 96);
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      try { const h = await fetch("/api/health", { cache: "no-store" }); if (h.ok) { target = 100; await sleep(350); location.reload(); return; } } catch (_) {}
    }
    fail("La versión nueva se instaló pero tardó en abrir. Cierra y vuelve a abrir Reel Studio.");
  } catch (e) { fail("No se pudo actualizar: " + e.message); }
}
$("#updateBtn").addEventListener("click", () => openUpdDlg(updInfo));
function openUpdDlg(u) {
  const news = (u && u.news && u.news.length) ? u.news : [{ title: "Mejoras y novedades", items: ["Mejoras de funcionamiento y estabilidad."] }];
  $("#updNews").innerHTML = news.map((n, i) => `<section class="${i === 0 ? "first" : ""}">${n.v ? `<div class="nv"><b>Versión ${esc(n.v)}</b><span>${esc(n.date || "")}</span></div>` : ""}
    <h3>${esc(n.title)}</h3><ul>${(n.items || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`).join("");
  const d = $("#updDlg"); if (!d.open) d.showModal();
}
$("#updDlgGo").addEventListener("click", () => { $("#updDlg").close(); runUpdate(); });
setInterval(checkUpdate, 3 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
window.addEventListener("focus", () => checkUpdate());
$("#checkUpdBtn").addEventListener("click", async () => {
  const b = $("#checkUpdBtn"); b.disabled = true; b.textContent = "Buscando…";
  try {
    const u = await api("GET", "/api/update?force=1");
    if (!u.configured) toast("Las actualizaciones no están configuradas en esta computadora.", 5000);
    else if (u.error) toast("No pude buscar actualizaciones. Revisa tu conexión a internet e inténtalo de nuevo.", 6000);
    else if (u.available) { updInfo = u; $("#updateBtn").hidden = false; showUpdPill(); openUpdDlg(u); }
    else toast("Ya tienes la última versión.");
  } catch (e) { toast("No pude buscar actualizaciones: " + e.message, 5000); }
  b.disabled = false; b.textContent = "Buscar actualizaciones";
});

/* cápsula de vidrio que se desliza entre opciones */
const CARD_SEL = ".vibes, .fmtcards, .looks, .presets, .formats, .trans";
const GLIDE_SEL = ".tabs, .seg, " + CARD_SEL;
function placeGlider(box, animate) {
  let g = box.querySelector(":scope > .glider");
  const on = box.querySelector(":scope > button.on");
  if (!on || on.offsetWidth === 0) { if (g) g.style.opacity = "0"; return; }
  const key = box.id || (box.closest("[id]") ? box.closest("[id]").id + ":" + box.className : "");
  if (!g) {
    g = document.createElement("span"); g.className = "glider"; box.prepend(g); box.classList.add("has-glider");
    if (box.matches(CARD_SEL)) box.classList.add("glide-cards");
    g._pos = key && gliderMem[key]; animate = !!g._pos;
  }
  const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
  const from = g._pos;
  if (key) gliderMem[key] = to;
  g.style.opacity = "1";
  g.style.width = to.w + "px"; g.style.height = to.h + "px";
  g.style.transform = `translate(${to.x}px, ${to.y}px)`;
  g._pos = to;
  if (!animate || !from || (from.x === to.x && from.y === to.y && from.w === to.w) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // La cápsula se convierte en una lupa de vidrio más grande que la barra, viaja y vuelve a su tamaño.
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const cardsBox = box.classList.contains("glide-cards");
  const dur = Math.min(600, 380 + dist * 0.35);
  const grow = cardsBox ? 0.04 : Math.min(0.2, 0.1 + dist / 3000);
  if (g._anim) g._anim.cancel();
  clearTimeout(g._lensT);
  requestAnimationFrame(() => g.classList.add("lens"));
  g._lensT = setTimeout(() => g.classList.remove("lens"), dur * 0.7);
  // Solo «transform» (lo mueve la tarjeta gráfica, sin recalcular la página): 30 cuadros calculados
  // con una curva suave + un leve inflado en el camino → se ve fluido a 60/120 Hz.
  const ease = (p) => { const c = 0.7, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; };
  const fcx = from.x + from.w / 2, fcy = from.y + from.h / 2, tcx = to.x + to.w / 2, tcy = to.y + to.h / 2;
  const frames = [];
  for (let i = 0; i <= 30; i++) {
    const p = i / 30, e = ease(p), bl = Math.sin(Math.PI * p) * grow;
    const w = from.w + (to.w - from.w) * e, h = from.h + (to.h - from.h) * e;
    const cx = fcx + (tcx - fcx) * e, cy = fcy + (tcy - fcy) * e;
    frames.push({ transform: `translate(${(cx - to.w / 2).toFixed(2)}px, ${(cy - to.h / 2).toFixed(2)}px) scale(${(w / to.w * (1 + bl * 0.6)).toFixed(4)}, ${(h / to.h * (1 + bl)).toFixed(4)})` });
  }
  g.style.transformOrigin = "50% 50%";
  g._anim = g.animate(frames, { duration: dur, easing: "linear" });
}
let gliderQueued = false, gliderAnimate = false;
const gliderMem = {};
function queueGliders(animate) {
  gliderAnimate = gliderAnimate || animate;
  if (gliderQueued) return;
  gliderQueued = true;
  requestAnimationFrame(() => {
    gliderQueued = false;
    const anim = gliderAnimate; gliderAnimate = false;
    $$(GLIDE_SEL).forEach((b) => placeGlider(b, anim));
  });
}
new MutationObserver((muts) => {
  let classChange = false, structure = false;
  for (const m of muts) {
    if (m.type === "attributes" && m.target.tagName === "BUTTON" && m.target.parentElement && m.target.parentElement.matches(GLIDE_SEL)) classChange = true;
    else if (m.type === "childList") structure = true;
  }
  if (classChange || structure) queueGliders(classChange);
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", () => queueGliders(false));

/* ---------------------------------------------------------------- animaciones (HyperFrames) */
const ANIM_LABEL = { titulo: "Título", frase: "Frase destacada", nombre: "Nombre y cargo", llamada: "Llamada a la acción", dato: "Número que sube" };
const ANIM_DEF = {
  titulo: { text: "Tu título aquí", sub: "", dur: 3, pos: "centro" }, frase: { text: "Dato clave", sub: "", dur: 2.5, pos: "arriba" },
  nombre: { text: "Tu nombre", sub: "Lo que haces", dur: 4, pos: "abajo" }, llamada: { text: "Sígueme para más", sub: "", dur: 3.5, pos: "abajo" },
  dato: { text: "100", sub: "clientes felices", dur: 3, pos: "centro" },
};
const ANIM_ICON = {
  titulo: '<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  frase: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="4" fill="currentColor" opacity=".9"/></svg>',
  nombre: '<svg viewBox="0 0 24 24"><rect x="4" y="13" width="3" height="7" rx="1.5" fill="currentColor"/><path d="M10 15h9M10 19h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  llamada: '<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="10" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="12" r="2.6" fill="currentColor"/></svg>',
  dato: '<svg viewBox="0 0 24 24"><path d="M5 18V12M10 18V8M15 18v-4M20 18V5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
};
S.animStatus = null;
const animFrames = {};
function animVer(a) {
  const P = S.P, kit = S.brands.find((x) => x.id === P.settings.brand) || {};
  return encodeURIComponent([a.kind, a.text, a.sub, a.dur, a.pos, P.settings.format, P.settings.brand, kit.fontFile, (kit.colors || {}).accent, P.style.highlight].join("|"));
}
function drawAnims(t, G, k) {
  const layer = $("#animLayer"), P = S.P;
  const act = t < 0 ? [] : (P.anims || []).filter((a) => a.on !== false && t >= +a.start && t < +a.start + +a.dur);
  const want = new Set(act.map((a) => a.id));
  for (const id in animFrames) if (!want.has(id)) animFrames[id].style.display = "none";
  for (const a of act) {
    let f = animFrames[a.id];
    const v = animVer(a);
    if (!f || !layer.contains(f)) {
      f = document.createElement("iframe"); f.className = "animf"; f.setAttribute("tabindex", "-1"); f.setAttribute("aria-hidden", "true");
      layer.appendChild(f); animFrames[a.id] = f;
    }
    if (f.dataset.v !== v || f.dataset.pid !== P.id) {
      f.dataset.v = v; f.dataset.pid = P.id; f.dataset.ready = "";
      f.onload = () => { f.dataset.ready = "1"; S.capKey = null; drawFrame(); };
      f.src = `/anim/${P.id}/${a.id}/index.html?v=${v}`;
    }
    f.style.width = G.W + "px"; f.style.height = G.H + "px"; f.style.transform = `scale(${k})`;
    f.style.display = "block";
    if (f.dataset.ready) {
      try { const tl = f.contentWindow.__timelines && f.contentWindow.__timelines.main; if (tl) tl.seek(clamp(t - a.start, 0, a.dur - 0.001), false); } catch (_) {}
    }
  }
}
function addAnim(kind, at) {
  if (!S.P) return;
  const d = ANIM_DEF[kind] || ANIM_DEF.titulo, total = S.plan ? S.plan.total : 10;
  const start = clamp(at ?? S.outT, 0, Math.max(0, total - 1));
  const a = { id: newId(), kind, text: d.text, sub: d.sub, dur: Math.min(d.dur, Math.max(1, total - start)), pos: d.pos, start: Math.round(start * 100) / 100, on: true };
  pushHistory(); S.P.anims.push(a); S.selAnim = a.id;
  changed(); showTab("t-anim");
  setTimeout(() => { const el = $(`#an-text-${a.id}`); if (el) { el.focus(); el.select(); } }, 60);
}
async function refreshAnimStatus() { try { S.animStatus = await api("GET", "/api/anims"); } catch (_) {} return S.animStatus; }
function renderAnim() {
  const P = S.P, el = $("#t-anim"), list = [...(P.anims || [])].sort((a, b) => a.start - b.start), st = S.animStatus;
  const kinds = Object.keys(ANIM_LABEL).map((k) => `<button class="akind" data-add="${k}">${ANIM_ICON[k]}<span>${ANIM_LABEL[k]}</span></button>`).join("");
  const engine = !st ? "" : st.ready ? "" : st.installing
    ? `<div class="note"><span class="spin"></span> Activando el motor de animaciones… (solo esta vez)</div>`
    : `<div class="note">Las animaciones se ven aquí al instante. Para exportarlas, Reel Studio descarga su motor una sola vez (unos 150 MB). <button class="btn small" id="animInstall">Activar ahora</button></div>`;
  const card = (a) => {
    const open = S.selAnim === a.id;
    const subLabel = a.kind === "nombre" ? "Cargo" : a.kind === "dato" ? "Texto debajo" : a.kind === "titulo" ? "Subtítulo (opcional)" : "";
    return `<div class="acard ${open ? "open" : ""} ${a.on === false ? "off" : ""}" data-aid="${a.id}">
      <div class="ahead"><span class="aic">${ANIM_ICON[a.kind]}</span><b>${esc(a.text || ANIM_LABEL[a.kind])}</b><span class="fine">${fmt(a.start)} · ${num(a.dur, 1)} s</span></div>
      ${open ? `<div class="abody">
        <div class="field"><label for="an-text-${a.id}">${a.kind === "dato" ? "Número (puede llevar $, %, +)" : "Texto"}</label><input class="textin" id="an-text-${a.id}" value="${esc(a.text)}" maxlength="70"></div>
        ${subLabel ? `<div class="field"><label for="an-sub-${a.id}">${subLabel}</label><input class="textin" id="an-sub-${a.id}" value="${esc(a.sub || "")}" maxlength="60"></div>` : ""}
        <div class="field"><label>Lugar</label><div class="seg" id="an-pos-${a.id}">${["arriba", "centro", "abajo"].map((p) => `<button type="button" data-v="${p}" class="${a.pos === p ? "on" : ""}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</div></div>
        ${slider("an-dur-" + a.id, "Duración", a.dur, 1, 8, 0.1, num(a.dur, 1) + " s")}
        <div class="row-btns"><button class="btn small" data-here="${a.id}">Que empiece aquí (${fmt(S.outT)})</button><button class="btn small ghost" data-play="${a.id}">Ver</button>
          <button class="btn small ghost" data-toggle="${a.id}">${a.on === false ? "Mostrar" : "Ocultar"}</button><button class="btn small ghost danger" data-del="${a.id}">Quitar</button></div>
      </div>` : ""}</div>`;
  };
  el.innerHTML = `<h3>Animaciones</h3>
    <p class="fine">Elige una y aparece donde está la línea de reproducción. Luego escribe el texto y listo.</p>
    <div class="akinds">${kinds}</div>
    ${engine}
    <div class="alist">${list.map(card).join("") || ""}</div>
    <details class="auto-anim"><summary>Proponer animaciones automáticamente</summary>
      <div class="field"><label for="aaTitle">Título</label><input id="aaTitle" class="textin" placeholder="Vacío: uso tus primeras palabras"></div>
      <div class="field"><label for="aaCta">Llamada al final</label><input id="aaCta" class="textin" value="Sígueme para más"></div>
      <button class="btn small" id="aaGo">Proponer</button></details>`;
  $$("#t-anim [data-add]").forEach((b) => (b.onclick = () => addAnim(b.dataset.add)));
  $$("#t-anim .ahead").forEach((h) => (h.onclick = () => { const id = h.parentElement.dataset.aid; S.selAnim = S.selAnim === id ? null : id; const a = P.anims.find((x) => x.id === id); if (a && S.selAnim) seek(+a.start + Math.min(0.9, a.dur / 2)); renderAnim(); renderTimeline(); }));
  const A = (id) => P.anims.find((x) => x.id === id);
  for (const a of list) {
    const tx = $("#an-text-" + a.id), sb = $("#an-sub-" + a.id);
    if (tx) tx.oninput = () => { a.text = tx.value; scheduleSave(); renderTimeline(); drawFrame(); const b = tx.closest(".acard").querySelector(".ahead b"); b.textContent = a.text || ANIM_LABEL[a.kind]; };
    if (tx) tx.onfocus = () => pushHistory();
    if (sb) { sb.oninput = () => { a.sub = sb.value; scheduleSave(); drawFrame(); }; sb.onfocus = () => pushHistory(); }
    const ps = $("#an-pos-" + a.id);
    if (ps) ps.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; pushHistory(); a.pos = b.dataset.v; changed(); };
    bindRange("an-dur-" + a.id, (v) => { a.dur = Math.min(+v, Math.max(0.8, S.plan.total - a.start)); renderTimeline(); drawFrame(); }, (v) => num(v, 1) + " s");
  }
  $$("#t-anim [data-here]").forEach((b) => (b.onclick = () => { const a = A(b.dataset.here); pushHistory(); a.start = Math.round(clamp(S.outT, 0, S.plan.total - 0.5) * 100) / 100; changed(); }));
  $$("#t-anim [data-play]").forEach((b) => (b.onclick = () => { const a = A(b.dataset.play); seek(+a.start); play(); }));
  $$("#t-anim [data-toggle]").forEach((b) => (b.onclick = () => { const a = A(b.dataset.toggle); pushHistory(); a.on = a.on === false; changed(); }));
  $$("#t-anim [data-del]").forEach((b) => (b.onclick = () => { pushHistory(); P.anims = P.anims.filter((x) => x.id !== b.dataset.del); S.selAnim = null; changed(); }));
  const inst = $("#animInstall");
  if (inst) inst.onclick = async () => { await api("POST", "/api/anims/install", {}); S.animStatus = { ...(S.animStatus || {}), installing: true }; renderAnim(); watchAnimInstall(); };
  $("#aaGo").onclick = async () => {
    await flushSave(); pushHistory();
    try { S.P = await api("POST", `/api/projects/${P.id}/anims/auto`, { title: $("#aaTitle").value, cta: $("#aaCta").value }); } catch (e) { return toast(e.message, 5000); }
    render(); toast(`Listo: ${S.P.anims.length} animaciones. Toca cualquiera para cambiar el texto.`);
  };
  if (!st) refreshAnimStatus().then(() => S.tab === "t-anim" && renderAnim());
}
async function watchAnimInstall() {
  for (let i = 0; i < 400; i++) {
    await sleep(2000);
    const s = await refreshAnimStatus();
    if (s && !s.installing) { if (S.tab === "t-anim") renderAnim(); if (s.ready) toast("Animaciones activadas."); return; }
  }
}
$("#addAnimBtn").addEventListener("click", () => { if (!S.P) return toast("Primero crea o abre un proyecto."); showTab("t-anim"); });
$("#laneAnim").addEventListener("pointerdown", (e) => {
  const blk = e.target.closest("[data-anim]"); if (!blk) return;
  e.preventDefault(); e.stopPropagation();
  const a = S.P.anims.find((x) => x.id === blk.dataset.anim), x0 = e.clientX, s0 = +a.start;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 4) return;
    if (!moved) { pushHistory(); moved = true; }
    a.start = Math.round(clamp(s0 + (ev.clientX - x0) / S.pps, 0, Math.max(0, S.plan.total - 0.5)) * 100) / 100;
    blk.style.left = a.start * S.pps + "px"; seek(a.start + 0.05);
  };
  const up = () => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
    if (moved) { changed(); return; }
    S.selAnim = S.selAnim === a.id && S.tab === "t-anim" ? null : a.id;
    if (S.selAnim) seek(+a.start + Math.min(0.9, a.dur / 2));
    renderTimeline(); showTab("t-anim");
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
});

/* ---------------------------------------------------------------- «Hacer mi video» */
S.make = { style: "dinamico" };
const VIBES = [
  ["dinamico", "Dinámico", "Rápido, zoom, color vivo"], ["viral", "Viral", "Cortes secos, palabras gigantes"],
  ["energetico", "Energético", "Muy rápido, barridos, deporte"], ["elegante", "Elegante", "Disolvencias, look de cine"],
  ["cinematico", "Cinemático", "Pausado, fundidos a negro, mate"], ["corporativo", "Corporativo", "Limpio y sobrio, para empresas"],
  ["calido", "Cálido", "Tonos cálidos, lifestyle"], ["vintage", "Vintage", "Grano y color de época"],
  ["bn", "Blanco y negro", "Dramático y elegante"], ["natural", "Natural", "Simple y real"],
];
function vibeCards() { return VIBES.map(([k, l, d]) => `<button type="button" data-v="${k}" class="${S.make.style === k ? "on" : ""}"><b>${l}</b><span>${d}</span></button>`).join(""); }
function openMake() {
  if (!S.P || !S.P.clips.length) return toast("Primero agrega tus videos.");
  const d = $("#makeDlg");
  $("#mVibe").innerHTML = vibeCards();
  const f = S.P.settings.format;
  $("#mFmt").innerHTML = fmtCards(f);
  d.showModal();
}
$("#makeBtn").addEventListener("click", openMake);
$("#mVibe").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.make.style = b.dataset.v; $$("#mVibe button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#mFmt").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $$("#mFmt button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#mGo").addEventListener("click", () => {
  const fmtB = $("#mFmt button.on");
  const body = { style: S.make.style, format: fmtB ? fmtB.dataset.v : S.P.settings.format, title: $("#mTitle").value, cta: $("#mCta").value,
    clean: $("#mClean").checked, subtitles: $("#mSubs").checked, anims: $("#mAnims").checked, highlight: true };
  $("#makeDlg").close();
  runMake(body);
});
async function runMake(body) {
  const pid = S.P.id;
  if (S.P.guide) { S.P.guide = false; scheduleSave(); }
  await flushSave(); pushHistory(); render();
  let jb;
  try { jb = await api("POST", `/api/projects/${pid}/make`, body); } catch (e) { return toast(e.message, 5000); }
  S.makeJobs = S.makeJobs || {};
  S.makeJobs[pid] = { ...jb, started: jb.started || Date.now() / 1000 };
  renderMakeOv();
}

/* «Hacer mi video» en marcha: panel con progreso y tiempo restante; se puede cambiar de proyecto */
S.makeJobs = {};
function etaText(j) {
  const p = j.progress || 0, el = Date.now() / 1000 - (j.started || Date.now() / 1000);
  if (p < 0.06 || el < 4) return "Calculando el tiempo…";
  const left = Math.max(5, el * (1 - p) / p);
  return left < 60 ? `Quedan unos ${Math.ceil(left / 5) * 5} segundos` : `Quedan unos ${Math.round(left / 60)} min`;
}
function renderMakeOv() {
  let ov = $("#makeOv");
  const j = S.P && S.makeJobs[S.P.id];
  document.body.classList.toggle("making", !!j);
  if (!j) { if (ov) ov.remove(); return; }
  if (!ov) {
    ov = document.createElement("div"); ov.id = "makeOv";
    ov.innerHTML = `<div class="mk-card glass"><div class="mk-orb"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="trk"/><circle cx="60" cy="60" r="52" class="arc"/></svg><b class="mk-pct">0%</b></div>
      <h2>Haciendo tu video</h2><p class="mk-msg"></p><p class="mk-eta fine"></p>
      <div class="mk-btns"><button class="btn" type="button" id="mkHome">Ir a mis proyectos</button></div>
      <p class="fine mk-note">Puedes cambiar de proyecto o cerrar esta ventana: el video se sigue haciendo y te aviso cuando esté listo.</p></div>`;
    $("#viewer").appendChild(ov);
    ov.querySelector("#mkHome").onclick = () => showHome();
  }
  const p = Math.max(0.02, j.progress || 0);
  ov.querySelector(".arc").style.strokeDashoffset = (326.7 * (1 - p)).toFixed(1);
  ov.querySelector(".mk-pct").textContent = Math.round(p * 100) + "%";
  ov.querySelector(".mk-msg").textContent = j.message || "Preparando…";
  ov.querySelector(".mk-eta").textContent = etaText(j);
}
/* al terminar: resumen de lo que se hizo y la línea de tiempo resaltada */
function showMadeSummary() {
  const P = S.P; if (!P) return;
  const st = P.settings, cuts = (P.words || []).filter((w) => w.cut).length;
  const main = S.plan ? S.plan.items.filter((i) => i.kind === "clip").length : 0;
  const look = ((S.meta.looks || {})[st.grade && st.grade.look] || {}).label;
  const tr = st.transition && st.transition.type;
  const facts = [
    [fmt(S.plan ? S.plan.total : 0), "duración"],
    [main, main === 1 ? "toma" : "tomas"],
    [(P.broll || []).length, "de apoyo"],
    [cuts, "palabras cortadas"],
    [(P.anims || []).length, "animaciones"],
  ];
  let card = $("#madeCard"); if (card) card.remove();
  card = document.createElement("div"); card.id = "madeCard"; card.className = "made glass";
  card.innerHTML = `<div class="made-h"><b>✦ Tu video está listo</b><button class="upd-x" aria-label="Cerrar">×</button></div>
    <div class="made-facts">${facts.map(([v, l]) => `<span><b>${v}</b><small>${l}</small></span>`).join("")}</div>
    ${P.madeNotes && P.madeNotes.prompt ? `<p class="fine made-ask">${P.madeNotes.understood.length ? `<b>De lo que pediste:</b> ${P.madeNotes.understood.map(esc).join(" · ")}.` : "No reconocí instrucciones concretas en lo que escribiste; prueba con frases como «ritmo rápido», «subtítulos amarillos» o «que dure 1 minuto»."}</p>` : ""}
    <p class="fine">${look ? `Look «${esc(look)}»` : ""}${tr ? ` · transición «${esc(tr)}»` : ""}${st.subtitles ? " · subtítulos" : ""}. Todo está en la línea de tiempo: toca cualquier parte para cambiarla.</p>
    <div class="made-btns"><button class="btn small" id="madeEdit">Ver la edición</button><button class="btn small primary" id="madeExp">Exportar</button></div>`;
  $("#viewer").appendChild(card);
  card.querySelector(".upd-x").onclick = () => card.remove();
  card.querySelector("#madeEdit").onclick = () => { card.remove(); setRender(false); $("#renderToggle").checked = false; flashTimeline(); };
  card.querySelector("#madeExp").onclick = () => { card.remove(); $("#exportBtn").click(); };
  flashTimeline();
}
function flashTimeline() {
  $("#tlScroll").scrollLeft = 0;
  const blks = $$("#timeline .blk, #laneMusic > *");
  blks.forEach((b, i) => { b.classList.remove("fresh"); void b.offsetWidth; b.style.animationDelay = Math.min(i * 70, 900) + "ms"; b.classList.add("fresh"); });
  setTimeout(() => blks.forEach((b) => { b.classList.remove("fresh"); b.style.animationDelay = ""; }), 2600);
}
async function trackMakes(jobs) {
  const now = {};
  jobs.filter((x) => x.kind === "make").forEach((x) => (now[x.project] = x));
  for (const pid in S.makeJobs) {
    if (now[pid]) continue;
    const old = S.makeJobs[pid]; delete S.makeJobs[pid];
    let fin = null; try { fin = await api("GET", `/api/jobs/${old.id}`); } catch (_) {}
    const name = (S.projects.find((x) => x.id === pid) || {}).name || "tu proyecto";
    if (fin && fin.status === "error") { toast(`«${name}»: no se pudo terminar. ${fin.error || ""}`, 7000); continue; }
    if (S.P && S.P.id === pid) {
      renderMakeOv(); await openProject(pid);
      S.previewReady = pid; $("#renderToggleWrap").hidden = false; $("#renderToggle").checked = true;
      seek(0); setRender(true); play();
      showMadeSummary();
    } else toast(`✓ «${name}» está listo. Ábrelo desde tus proyectos.`, 6000);
  }
  Object.assign(S.makeJobs, now);
  renderMakeOv();
  if (!$("#home").hidden) renderHome();
}

/* ---------------------------------------------------------------- inicio guiado */
const FMT_USE = {
  vertical: "Reels, TikTok, Stories", horizontal: "YouTube", "4:5": "Feed Instagram",
  "5:4": "Feed horizontal", cuadrado: "Feed, LinkedIn",
};
function fmtCards(sel) {
  return Object.entries(S.meta.formats).map(([k, v]) => {
    const r = v.w / v.h, h = 30, w = Math.round(h * r);
    return `<button type="button" data-v="${k}" class="${k === sel ? "on" : ""}" title="${esc(v.label)}">
      <span class="fshape" style="width:${Math.min(w, 46)}px;height:${w > 46 ? Math.round(46 / r) : h}px"></span>
      <b>${fmtShort(k)}</b><span>${FMT_USE[k] || v.label}</span></button>`;
  }).join("");
}
function renderGuide() {
  const P = S.P;
  if (!$("#gVibe").querySelector("button")) $("#gVibe").innerHTML = vibeCards();
  $$("#gVibe button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.make.style));
  const f = P ? P.settings.format : "vertical";
  if (S.meta) $("#gFmt").innerHTML = fmtCards(f);
  $("#gClips").innerHTML = P ? P.clips.map((c) => {
    const ok = ["listo", "sin voz", "sin transcribir"].includes(c.status);
    if (c.status === "sin transcribir") return `<span class="gclip ok">✓ ${esc(c.name)} <span class="fine" style="margin:0">· sin transcribir</span></span>`;
    return `<span class="gclip ${ok ? "ok" : ""}">${ok ? "✓" : '<span class="spin"></span>'} ${esc(c.name)}</span>`;
  }).join("") : "";
  const ref = P && P.reference;
  $("#gRefName").textContent = ref && ref.file ? `Referencia: ${ref.name}${ref.analysis ? " ✓" : " (analizando…)"}` : "";
  if (P && ref && ref.prompt && !$("#gPrompt").value) { $("#gPrompt").value = ref.prompt; growTA($("#gPrompt")); }
  if (P && $("#gMax") && !$("#gMax").querySelector("input")) $("#gMax").outerHTML = maxDurSeg("gMax", P.settings.maxDur);
  if (P) $("#gAutoT").checked = !!P.settings.autoTranscribe;
  $(".gorder").hidden = !(P && P.clips.length > 1);
  if (P) $$("#gOrder button").forEach((b) => b.classList.toggle("on", b.dataset.v === (P.settings.clipOrder || "num-asc")));
  if (P) {
    const va = S.make.videoAudio !== false;
    $$("#gVA button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "1") === va));
    const vz = P.settings.voice || {}, mu = P.settings.music || {};
    $("#gVoiceName").innerHTML = vz.file ? `✓ ${esc(vz.name)} · ${fmt(vz.duration || 0)}${vz.status === "transcribiendo" ? " · transcribiendo…" : ""} <a href="#" id="gVoiceDel">quitar</a>` : "El video se arma sobre tu voz y dura lo mismo.";
    $("#gMusicName").innerHTML = mu.file ? `✓ ${esc(mu.name)}${mu.tempo ? ` · ${Math.round(mu.tempo)} BPM` : ""} <a href="#" id="gMusicDel">quitar</a>` : "Los cortes siguen el ritmo.";
    $("#gVAnote").textContent = va ? "Se usa su voz para subtítulos y cortes." : (vz.file ? "Solo se oye tu narración (y la música)." : "Sin voz: no se transcribe ni se ponen subtítulos.");
    if (!va && !vz.file) { $("#gSubs").checked = false; }
  }
  if (P && !S._gSubsInit) { $("#gSubs").checked = P.settings.subtitles !== false; S._gSubsInit = true; }
  const ready = !!(P && P.clips.length);
  $("#gGo").disabled = !ready;
  $("#gNote").textContent = ready ? `${P.clips.length} video${P.clips.length > 1 ? "s" : ""} · estilo ${(VIBES.find((v) => v[0] === S.make.style) || [, ""])[1]}` : "Primero elige tus videos en el paso 1";
  $("#gManual").hidden = !(P && P.clips.length);
}
$("#gVibe").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.make.style = b.dataset.v; renderGuide(); });
$("#gFmt").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#gFmt button").forEach((x) => x.classList.toggle("on", x === b));
  if (S.P) { S.P.settings.format = b.dataset.v; scheduleSave(); }
});
$("#gRefFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (!S.P) { const id = await newProject("Mi video"); if (!id) return; }
  await addReference(f); renderGuide();
});
$("#gChips").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const t = $("#gPrompt"), add = b.textContent.toLowerCase();
  t.value = t.value.trim() ? t.value.trim().replace(/[.,]?$/, ", ") + add : b.textContent; t.focus(); growTA(t);
});
$("#gVA").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.make.videoAudio = b.dataset.v === "1"; if (S.make.videoAudio) $("#gSubs").checked = true; renderGuide(); });
async function addVoice(file) {
  if (!S.P) { const id = await newProject("Mi video"); if (!id) return; }
  S.uploading = true; $("#jobChip").hidden = false;
  try { await upload(`/api/projects/${S.P.id}/voice?filename=${encodeURIComponent(file.name)}`, file, (x) => ($("#jobText").textContent = `Copiando narración ${Math.round(x * 100)} %`)); }
  catch (e) { S.uploading = false; return toast(e.message, 5000); }
  S.uploading = false; $("#gSubs").checked = true; toast("Narración agregada. La estoy transcribiendo para los subtítulos.");
  await openProject(S.P.id);
}
$("#gVoiceFile").addEventListener("change", (e) => { if (e.target.files[0]) addVoice(e.target.files[0]); e.target.value = ""; });
$("#gMusicFile").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (!S.P) { const id = await newProject("Mi video"); if (!id) return; } await addMusic(f); setTimeout(() => openProject(S.P.id), 1500); });
document.addEventListener("click", async (e) => {
  const v = e.target.closest("#gVoiceDel"), m = e.target.closest("#gMusicDel"); if (!v && !m) return;
  e.preventDefault(); await api("DELETE", `/api/projects/${S.P.id}/${v ? "voice" : "music"}`); await openProject(S.P.id);
});
$("#gOrder").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b || !S.P) return;
  await flushSave(); pushHistory();
  try { S.P = await api("POST", `/api/projects/${S.P.id}/sort`, { mode: b.dataset.v }); } catch (er) { return toast(er.message, 4000); }
  render(); toast("Videos ordenados " + b.title.toLowerCase().replace("por ", "por "));
});
$("#gAutoT").addEventListener("change", (e) => { if (S.P) { S.P.settings.autoTranscribe = e.target.checked; scheduleSave(); } });
async function transcribeNow(cid) {
  if (!S.P) return; await flushSave();
  try { await api("POST", `/api/projects/${S.P.id}/transcribe/${cid || "todos"}`, {}); toast("Transcribiendo… puedes seguir editando."); } catch (e) { toast(e.message, 5000); }
}
$("#gManual").addEventListener("click", (e) => { e.preventDefault(); if (!S.P) return; S.P.guide = false; scheduleSave(); render(); });
$("#gGo").addEventListener("click", async () => {
  const P = S.P; if (!P || !P.clips.length) return toast("Primero elige tus videos (paso 1).");
  const prompt = $("#gPrompt").value.trim();
  if (prompt) {
    if (P.reference) { P.reference.prompt = prompt; scheduleSave(); }
    try { await flushSave(); await api("POST", `/api/projects/${P.id}/requests`, { text: prompt, kind: P.reference ? "referencia" : "" }); } catch (_) {}
  }
  const fmtB = $("#gFmt button.on");
  runMake({ style: S.make.style, format: fmtB ? fmtB.dataset.v : P.settings.format, title: $("#gTitle").value, cta: $("#gCta").value,
    maxDur: S.P.settings.maxDur || 0, videoAudio: S.make.videoAudio !== false,
    clean: true, subtitles: $("#gSubs").checked, anims: $("#gAnims").checked, highlight: true, prompt });
  $("#gPrompt").value = "";
});

/* ---------------------------------------------------------------- pegar enlaces (yt-dlp) */
function openLink(as) {
  if (!S.P && as !== "clip") return toast("Primero crea o abre un proyecto.");
  $("#linkUrl").value = ""; $$("#linkAs button").forEach((b) => b.classList.toggle("on", b.dataset.v === (as || "clip")));
  $("#linkDlg").showModal();
  navigator.clipboard && navigator.clipboard.readText && navigator.clipboard.readText().then((t) => { if (/^https?:\/\//.test(t || "") && !$("#linkUrl").value) $("#linkUrl").value = t.trim(); }).catch(() => {});
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-link]"); if (b) { e.preventDefault(); openLink(b.dataset.link); } });
$("#linkAs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) $$("#linkAs button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#linkUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#linkGo").click(); } });
$("#linkGo").addEventListener("click", async () => {
  const url = $("#linkUrl").value.trim(), as = ($("#linkAs button.on") || {}).dataset?.v || "clip";
  if (!/^https?:\/\//.test(url)) return toast("Pega un enlace que empiece con https://");
  $("#linkDlg").close();
  if (!S.P) { const id = await newProject("Video desde enlace"); if (!id) return; }
  const pid = S.P.id;
  let j;
  try { j = await api("POST", `/api/projects/${pid}/link`, { url, as }); } catch (e) { return toast(e.message, 5000); }
  toast("Bajando el video del enlace…");
  for (;;) { await sleep(1200); try { j = await api("GET", `/api/jobs/${j.id}`); } catch (_) { continue; } if (j.status !== "running") break; }
  if (j.status === "error") return toast("No pude bajar ese enlace: " + j.error.slice(0, 160), 7000);
  if (S.P && S.P.id === pid) await openProject(pid);
  loadProjects();
  toast(`Agregado: «${j.result.title}»` + (as === "clip" ? ". Lo estoy procesando." : ""), 4000);
});

/* ---------------------------------------------------------------- paneles que se pueden agrandar */
const LAYOUT_KEY = "rs-layout";
let layout = {};
try { layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {}; } catch (_) {}
const MIN_CENTER = 700;
function applyLayout() {
  const app = $("#app"), st = $(".stage");
  // si la ventana se achica, los paneles laterales ceden espacio para que nada se encime
  const room = innerWidth - 40 - MIN_CENTER;
  if (layout.side && layout.insp && layout.side + layout.insp > room) { const f = Math.max(0.5, room / (layout.side + layout.insp)); layout.side = Math.max(170, Math.round(layout.side * f)); layout.insp = Math.max(300, Math.round(layout.insp * f)); }
  else if (layout.insp && layout.insp + 236 > room) layout.insp = Math.max(300, room - 236);
  else if (layout.side && layout.side + 404 > room) layout.side = Math.max(170, room - 404);
  if (layout.side || layout.insp) {
    const cs = getComputedStyle(app).gridTemplateColumns.split(" ");
    app.style.gridTemplateColumns = `${layout.side ? layout.side + "px" : cs[0]} minmax(0, 1fr) ${layout.insp ? layout.insp + "px" : cs[2]}`;
  } else app.style.gridTemplateColumns = "";
  st.style.gridTemplateRows = layout.tl ? `minmax(0, 1fr) ${layout.tl}px` : "";
  placeResizers();
}
function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {} }
const rz = {};
["side", "insp", "tl"].forEach((k) => { const d = document.createElement("div"); d.className = "rz rz-" + k; d.title = "Arrastra para cambiar el tamaño · doble clic para volver al original"; document.body.appendChild(d); rz[k] = d; });
function placeResizers() {
  const sb = $(".sidebar").getBoundingClientRect(), ins = $(".inspector").getBoundingClientRect(), vw = $("#viewer").getBoundingClientRect(), tlr = $("#timeline").getBoundingClientRect();
  Object.assign(rz.side.style, { left: sb.right + "px", top: sb.top + "px", height: sb.height + "px", width: "10px" });
  Object.assign(rz.insp.style, { left: ins.left - 10 + "px", top: ins.top + "px", height: ins.height + "px", width: "10px" });
  Object.assign(rz.tl.style, { left: vw.left + "px", top: vw.bottom + "px", width: vw.width + "px", height: Math.max(4, tlr.top - vw.bottom) + "px" });
}
function afterLayout() { placeResizers(); sizeScreen(); if (S.P) { renderTimeline(); drawFrame(); } placeSelTools(); queueGliders(false); }
for (const k of ["side", "insp", "tl"]) {
  rz[k].addEventListener("pointerdown", (e) => {
    e.preventDefault(); rz[k].setPointerCapture(e.pointerId); document.body.classList.add("resizing", "resizing-" + (k === "tl" ? "v" : "h"));
    const x0 = e.clientX, y0 = e.clientY, side0 = $(".sidebar").offsetWidth, insp0 = $(".inspector").offsetWidth, tl0 = $("#timeline").offsetHeight;
    const mv = (ev) => {
      const room = innerWidth - 40 - MIN_CENTER;
      if (k === "side") layout.side = Math.round(clamp(side0 + ev.clientX - x0, 170, Math.max(170, Math.min(420, room - insp0))));
      if (k === "insp") layout.insp = Math.round(clamp(insp0 - (ev.clientX - x0), 300, Math.max(300, Math.min(720, room - side0))));
      if (k === "tl") layout.tl = Math.round(clamp(tl0 - (ev.clientY - y0), 150, innerHeight * 0.62));
      applyLayout(); afterLayout();
    };
    const up = () => { rz[k].removeEventListener("pointermove", mv); rz[k].removeEventListener("pointerup", up); document.body.classList.remove("resizing", "resizing-h", "resizing-v"); saveLayout(); };
    rz[k].addEventListener("pointermove", mv); rz[k].addEventListener("pointerup", up);
  });
  rz[k].addEventListener("dblclick", () => { delete layout[k]; saveLayout(); applyLayout(); afterLayout(); });
}
window.addEventListener("resize", () => requestAnimationFrame(() => { if (layout.side || layout.insp) applyLayout(); else placeResizers(); }));

/* ---------------------------------------------------------------- pantalla de inicio */
function hideSplash() {
  const sp = $("#splash"); if (!sp || sp.classList.contains("out")) return;
  const wait = Math.max(0, 2500 - (performance.now() - (window.__t0 || 0)));
  setTimeout(() => { sp.classList.add("out"); setTimeout(() => sp.remove(), 1000); }, wait);
}
/* ---------------------------------------------------------------- novedades */
async function showNews(onlyIfNew) {
  let list = [];
  try { list = await (await fetch("/static/novedades.json", { cache: "no-store" })).json(); } catch (_) { return; }
  if (!list.length) return;
  let seen = null; try { seen = localStorage.getItem("rs-news"); } catch (_) {}
  try { localStorage.setItem("rs-news", list[0].v); } catch (_) {}
  if (onlyIfNew && (!seen || seen === list[0].v)) return;
  $("#newsList").innerHTML = list.map((n, i) => `<section class="${i === 0 ? "first" : ""}"><div class="nv"><b>Versión ${esc(n.v)}</b><span>${esc(n.date)}</span></div>
    <h3>${esc(n.title)}</h3><ul>${n.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`).join("");
  const d = $("#newsDlg"); if (!d.open) d.showModal();
}
window.rsNews = () => showNews(false);
$("#newsBtn").addEventListener("click", () => showNews(false));
setTimeout(() => showNews(true), 3200);
/* sin zoom del programa: ni con los dedos en el trackpad, ni con ⌘+/⌘−, ni con Ctrl+rueda */
["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && ["+", "=", "-", "_", "0"].includes(e.key)) e.preventDefault(); }, true);
window.__t0 = performance.now();
// El logo y el sonido arrancan juntos: la animación espera a que el audio esté listo (máximo 0,8 s)
(function startSplash() {
  const sp = document.getElementById("splash"); if (!sp) return;
  let started = false;
  const start = () => { if (started) return; started = true; window.__t0 = performance.now(); sp.classList.add("go"); };
  try {
    const snd = new Audio("/static/inicio.m4a"); snd.preload = "auto"; snd.volume = 0.5;
    // la animación arranca cuando el sonido YA está sonando (+ el retraso de los parlantes), así van juntos
    snd.addEventListener("playing", () => setTimeout(start, 90), { once: true });
    snd.addEventListener("canplaythrough", () => snd.play().catch(start), { once: true });
    snd.load();
    setTimeout(start, 1200);
  } catch (_) { start(); }
})();
(function centerLogo() { // el logo empieza solo en el centro y luego se corre para que salga el nombre
  const lk = document.getElementById("lk"); if (!lk) return;
  const w = lk.querySelector(".lk-word").getBoundingClientRect().width, gap = parseFloat(getComputedStyle(lk).columnGap) || 0;
  lk.style.setProperty("--shift", ((w + gap) / 2).toFixed(1) + "px");
  lk.querySelectorAll(".lk-in span").forEach((sp) => sp.style.setProperty("--x", (sp.offsetLeft + sp.offsetWidth + 4) + "px"));
  if (document.fonts && !centerLogo.done) { centerLogo.done = true; document.fonts.load('800 60px "Poppins ExtraBold"').then(centerLogo).catch(() => {}); }
})();
setTimeout(hideSplash, 4500);

(async function init() {
  S.meta = await api("GET", "/api/meta");
  await Promise.all([loadProjects(), loadBrands()]);
  const id = location.hash.slice(1);
  if (id) await openProject(id); else await showHome();
  applyLayout(); sizeScreen(); hideSplash(); refreshAnimStatus();
  const ro = new ResizeObserver(() => { sizeScreen(); if (S.P) { renderTimeline(); drawFrame(); } placeResizers(); });
  ro.observe($("#screenWrap")); ro.observe($("#timeline")); ro.observe($(".stage"));
  requestAnimationFrame(tick);
  poll(); checkUpdate();
})();

/* el cuadro del pedido crece mientras escribes (sin límite de texto) */
function growTA(t) { t.style.height = "auto"; t.style.height = Math.max(96, t.scrollHeight + 2) + "px"; }
document.addEventListener("input", (e) => { if (e.target.matches && e.target.matches("textarea.autogrow, #refPrompt")) growTA(e.target); });
