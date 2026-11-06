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
  for (const it of P.timeline) {
    const c = clipOf(it.clip);
    if (!c || !["listo", "sin voz"].includes(c.status) || c.hasVideo === false) continue;
    let segs = itemSegments(P, it);
    if (!segs.length) continue;
    if (!c.speech) {
      const [a, b] = segs[0];
      let want = it.full ? b - a : Math.min(b - a, pace);
      if (beatSync) {
        const mt = clock - (+mus.start || 0);
        const cand = beats.map((x) => x - mt).filter((x) => x >= 0.6 && x <= b - a);
        if (cand.length) want = cand.reduce((p, x) => (Math.abs(x - want) < Math.abs(p - want) ? x : p));
      }
      segs = [[a, a + want]];
    }
    segs = snap(segs);
    if (!segs.length) continue;
    const dur = segs.reduce((n, [a, b]) => n + b - a, 0);
    items.push({ kind: "clip", clip: c.id, segs, dur, speech: !!c.speech, trans: it.transition });
    clock += dur;
  }
  if (st.outro && st.outro.on) items.push({ kind: "card", card: "outro", segs: [], dur: r30(+st.outro.dur || 2.5) });
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
  if (S.P && S.P.id === d.dataset.del) { S.P = null; location.hash = ""; render(); }
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

async function openProject(id) {
  if (!id) { S.P = null; render(); return; }
  let P;
  try { P = await api("GET", "/api/projects/" + id); } catch (_) { toast("No encontré ese proyecto."); location.hash = ""; return; }
  const isNew = !S.P || S.P.id !== id;
  S.P = P; S.dirty = false;
  if (isNew) { clearScreen(); S.history = []; S.sel = null; S.selClip = null; S.selBroll = null; S.selJunction = null; S.outT = 0; stop(); S.useRender = false; S.exp = null; $("#renderBadge").hidden = true; }
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
  $("#dropZone").hidden = !!(P && P.clips.length);
  $("#viewer").classList.toggle("empty", !(P && P.clips.length));
  $("#dzTitle").textContent = P ? "Agrega tus videos" : "Crea tu primer proyecto";
  $("#dzText").textContent = P ? "Arrastra aquí las tomas: hablando, de dron o de cámara. Puedes agregar más cuando quieras."
    : "Arrastra aquí tus videos (tomas hablando, de dron o de cámara). Se procesan en tu computadora; nada se sube a internet.";
  if (!P) {
    $("#durLabel").textContent = ""; renderProjects(); $$(".panel").forEach((p) => (p.innerHTML = ""));
    ["#laneMain", "#laneBroll", "#laneMusic", "#tlRuler"].forEach((s) => ($(s).innerHTML = ""));
    ["#exportBtn", "#previewBtn", "#assembleBtn", "#playBtn"].forEach((s) => ($(s).disabled = true));
    return;
  }
  recompute();
  ["#exportBtn", "#previewBtn"].forEach((s) => ($(s).disabled = !(S.plan && S.plan.items.length)));
  $("#assembleBtn").disabled = !P.clips.some((c) => ["listo", "sin voz"].includes(c.status));
  $("#playBtn").disabled = !(S.plan && S.plan.items.length);
  $("#undoBtn").disabled = !S.history.length;
  $("#renderToggleWrap").hidden = !S.previewReady || S.previewReady !== P.id;
  const pend = (P.requests || []).filter((r) => r.status === "pendiente").length;
  $("#reqBadge").hidden = !pend; $("#reqBadge").textContent = pend;
  sizeScreen(); renderProjects(); renderPanel(); S.capKey = null; drawFrame();
}
function renderPanel() {
  const f = { "t-texto": renderTexto, "t-clip": renderClips, "t-color": renderColor, "t-audio": renderAudio, "t-estilo": renderEstilo,
    "t-marca": renderMarca, "t-formato": renderFormato, "t-ref": renderRef, "t-pedidos": renderPedidos, "t-log": renderLog }[S.tab];
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
  return JSON.stringify({ w: P.words.map((w) => [w.cut, w.by, w.reason, w.text]), tl: P.timeline, br: P.broll, se: P.settings, st: P.style,
    cl: P.clips.map((c) => ({ id: c.id, adjust: c.adjust, gain: c.gain, fit: c.fit, cropX: c.cropX, cropY: c.cropY, speech: c.speech, muted: !!c.muted })) });
}
function pushHistory() { if (!S.P) return; S.history.push(snapshot()); if (S.history.length > 80) S.history.shift(); $("#undoBtn").disabled = false; }
function undo() {
  if (!S.history.length || !S.P) return;
  const h = JSON.parse(S.history.pop()), P = S.P;
  h.w.forEach((x, i) => { const w = P.words[i]; if (w) [w.cut, w.by, w.reason, w.text] = x; });
  P.timeline = h.tl; P.broll = h.br; P.settings = h.se; P.style = h.st;
  h.cl.forEach((x) => { const c = clipOf(x.id); if (c) Object.assign(c, x); });
  $("#undoBtn").disabled = !S.history.length;
  changed(); toast("Deshecho");
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
  const look = (S.meta.looks[g.look] || {}).css || "";
  const ex = (+g.exposure || 0) + (+a.exposure || 0), co = +g.contrast || 0, sa = (+g.saturation || 0) + (+a.saturation || 0);
  const te = (+g.temperature || 0) + (+a.temperature || 0);
  let f = look + ` brightness(${1 + ex * 0.22}) contrast(${1 + co * 0.35}) saturate(${Math.max(0, 1 + sa * 0.6)})`;
  if (te > 0) f += ` sepia(${te * 0.22}) saturate(${1 + te * 0.1})`; else if (te < 0) f += ` hue-rotate(${-te * 10}deg) brightness(${1 - te * 0.02})`;
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
  [vA, vB].forEach((x) => { x.classList.toggle("on", x === v); if (x !== v) x.pause(); });
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
function seek(t) {
  if (!S.P || !S.plan) return;
  S.outT = clamp(t, 0, S.plan.total);
  if (S.useRender) { vA.currentTime = S.outT; drawFrame(); return; }
  if (!S.plan.items.length) return;
  const loc = locate(S.outT);
  show(loc);
  if (loc && loc.itm.kind === "card") S.cardClock = { out: S.outT, perf: performance.now() };
  syncMusic(true); S.capKey = null; drawFrame();
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
  syncMusic(true);
}
function stop() {
  S.playing = false; setPlayIcon();
  [vA, vB, vBr].forEach((v) => v.pause()); music.pause();
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
  if (m.duck && S.cur && S.cur.itm.speech) vol *= 0.4;
  const fi = +m.fadeIn || 0, fo = +m.fadeOut || 0;
  if (fi && S.outT < fi) vol *= S.outT / fi;
  if (fo && S.outT > S.plan.total - fo) vol *= Math.max(0, (S.plan.total - S.outT) / fo);
  music.volume = clamp(vol, 0, 1);
  if (S.playing && music.paused) music.play().catch(() => {});
  if (!S.playing) music.pause();
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
      syncMusic(false);
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
  if (S.useRender) { vBr.classList.remove("on"); $("#cap").innerHTML = ""; $("#logoImg").style.display = "none"; S.capKey = null; return; }
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
      mh += `<div class="blk ${S.selClip === itm.clip && !S.selBroll ? "sel" : ""}" data-item="${itm.clip}" style="left:${left}px;width:${w}px;background-image:url(/media/${P.id}/file/${itm.clip}_strip.jpg)">
        ${itm.speech ? '<b class="voice">VOZ</b>' : ""}<span>${esc(c ? c.name : itm.clip)}</span></div>`;
    }
    if (j > 0) mh += `<div class="tchip ${S.selJunction === j ? "on" : ""}" data-junction="${j}" style="left:${(itm.start + itm.tdur / 2) * pps}px" title="${TRANS_LABEL[itm.ttype] || "Corte"}"></div>`;
  });
  const pending = P.clips.filter((c) => !["listo", "sin voz"].includes(c.status));
  if (pending.length) mh += `<div class="fine" style="position:absolute;right:8px;top:20px">${pending.length} clip${pending.length > 1 ? "s" : ""} procesándose…</div>`;
  if (!S.plan.items.length && !pending.length && P.clips.length) mh += `<div class="fine" style="position:absolute;left:10px;top:20px">La secuencia está vacía. Usa «Armar video» o la pestaña Clips.</div>`;
  $("#laneMain").innerHTML = mh;
  $("#laneBroll").innerHTML = (P.broll || []).map((b) => {
    const c = clipOf(b.clip); if (!c) return "";
    return `<div class="blk broll ${S.selBroll === b.id ? "sel" : ""}" data-broll="${b.id}" style="left:${(S.plan.mainStart + +b.at) * pps}px;width:${Math.max(6, b.dur * pps - 2)}px;background-image:url(/media/${P.id}/file/${b.clip}_strip.jpg)"><span>${esc(c.name)}</span></div>`;
  }).join("");
  const m = P.settings.music;
  if (m && m.file) {
    const w = Math.min(total, Math.max(0, (m.duration || total) - (+m.start || 0))) * pps;
    let bh = "";
    if (m.beatSync) for (const b of m.beats || []) { const x = b - (+m.start || 0); if (x >= 0 && x <= total) bh += `<i class="beat" style="left:${x * pps}px"></i>`; }
    $("#laneMusic").innerHTML = `<div class="mwave" style="left:0;width:${w}px;background-image:url(/media/${P.id}/file/music_wave.png?${encodeURIComponent(m.file + m.duration)});background-size:${(m.duration || total) * pps}px 100%;background-position:${-(+m.start || 0) * pps}px 0"></div>${bh}`;
  } else $("#laneMusic").innerHTML = `<span class="fine" style="position:absolute;left:10px;top:3px">Sin música · arrastra un MP3 o usa «+ Música»</span>`;
}
$("#tlRuler").addEventListener("pointerdown", (e) => tlSeek(e));
["#laneMain", "#laneBroll", "#laneMusic"].forEach((s) => $(s).addEventListener("pointerdown", (e) => {
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
      S.selClip = id; S.selBroll = null;
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
function renderTexto() {
  const P = S.P, box = $("#t-texto");
  const speechClips = orderedClips().filter((c) => c.speech);
  if (!speechClips.length) {
    const busy = P.clips.some((c) => !["listo", "sin voz"].includes(c.status));
    box.innerHTML = `<p class="empty-note">${busy ? "Transcribiendo… el texto aparece aquí en cuanto termine." : P.clips.length ? "Ningún clip tiene voz. Arma el montaje en la línea de tiempo y la pestaña Clips." : "Agrega videos para ver aquí lo que se dice."}</p>`;
    return;
  }
  const W = P.words, html = [`<div class="tip">Clic en una palabra para ir a ese momento. Arrastra o usa Shift para elegir varias y pulsa <b>⌫</b> para quitarlas. Doble clic corrige el subtítulo.</div>
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
    const role = roleOf(c.id), st = !["listo", "sin voz"].includes(c.status) ? "procesando…" : `${fmt(c.duration)} · ${c.width}×${c.height} · ${Math.round(c.fps)} fps${c.hdr ? " · HDR" : ""}`;
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
  bindRange("mVol", (v) => (m.volume = v), (v) => Math.round(v * 100) + " %");
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
  const tl = itm && itm.kind === "clip" ? P.timeline.find((t) => t.clip === itm.clip) : null;
  const active = itm ? (tl && tl.transition && tl.transition.type) || null : tr.type;
  const transBtns = Object.keys(TRANS_LABEL).map((k) => `<button data-t="${k}" class="${active === k ? "on" : ""}">${TRANS_LABEL[k]}</button>`).join("");
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
    if (itm && tl) tl.transition = { type: b.dataset.t }; else tr.type = b.dataset.t;
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
function fmtShort(k) { return k === "vertical" ? "9:16" : k === "horizontal" ? "16:9" : k === "cuadrado" ? "1:1" : k; }
function renderFormato() {
  const P = S.P, s = P.settings, box = $("#t-formato");
  const desc = { vertical: "Reels, TikTok", horizontal: "YouTube", "4:5": "Feed", "5:4": "Feed horizontal", cuadrado: "Cuadrado" };
  const fm = Object.entries(S.meta.formats).map(([k, f]) => `<button data-f="${k}" class="${s.format === k ? "on" : ""}"><i style="width:${Math.round(24 * f.w / f.h)}px"></i><b>${fmtShort(k)}</b><span>${desc[k]}</span></button>`).join("");
  const G = geom(), mixed = P.clips.some((c) => c.width && Math.abs(c.width / c.height - G.W / G.H) > 0.01);
  box.innerHTML = `<div class="sec"><h3>Formato del video</h3><div class="formats" id="fmtGrid">${fm}</div>
      <p class="fine">La resolución (720p, 1080p, 2K o 4K) y los fotogramas (24, 30 o 60) se eligen al exportar.</p></div>
    ${mixed ? `<div class="sec"><h3>Clips con otra forma</h3><div class="field"><label>Cómo encajan</label><div class="seg" id="fitSeg"><button data-v="llenar" class="${s.fit === "llenar" ? "on" : ""}">Recortar</button><button data-v="difuminado" class="${s.fit === "difuminado" ? "on" : ""}">Fondo difuminado</button></div></div>
      ${slider("cxR", "Mover el encuadre (horizontal)", s.cropX, 0, 1, 0.01, Math.round(s.cropX * 100) + " %")}${slider("cyR", "Mover el encuadre (vertical)", s.cropY, 0, 1, 0.01, Math.round(s.cropY * 100) + " %")}
      <p class="fine">Cada clip puede tener su propio encuadre en la pestaña Clips.</p></div>` : ""}
    <div class="sec"><h3>Tus clips</h3>${P.clips.map((c) => `<p class="fine">«${esc(c.name)}»: ${c.width || "?"}×${c.height || "?"} · ${c.fps ? Math.round(c.fps) : "?"} fps${c.hdr ? " · HDR" : ""}</p>`).join("") || '<p class="fine">Sin clips todavía.</p>'}</div>`;
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
  $("#expList").innerHTML = list.length ? `<p class="fine">Exportaciones de este proyecto</p>` + list.map((f) => `<div class="ex"><span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span>
    <a href="/media/${id}/export/${encodeURIComponent(f.name)}?dl=1">Descargar</a> · <a href="#" data-reveal="${esc(f.name)}">Mostrar</a></span></div>`).join("") : "";
}
$("#expList").addEventListener("click", (e) => { const b = e.target.closest("[data-reveal]"); if (b) { e.preventDefault(); api("POST", `/api/projects/${S.P.id}/reveal`, { file: b.dataset.reveal }); } });

/* ---------------------------------------------------------------- varios */
$("#projTitle").addEventListener("change", (e) => { if (!S.P) return; S.P.name = e.target.value.trim() || "Proyecto"; scheduleSave(); setTimeout(loadProjects, 900); });
$("#undoBtn").addEventListener("click", undo);
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (["input", "select", "textarea"].includes(tag) || document.querySelector("dialog[open]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (!S.P) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
  if ((e.key === "Backspace" || e.key === "Delete") && S.sel && S.tab === "t-texto") { e.preventDefault(); const idx = rangeIdx(); setCut(idx, !idx.every((i) => S.P.words[i].cut)); return; }
  if ((e.key === "Backspace" || e.key === "Delete") && S.selBroll) { e.preventDefault(); pushHistory(); S.P.broll = S.P.broll.filter((x) => x.id !== S.selBroll); S.selBroll = null; changed(); return; }
  if (e.key === "Escape") { setSel(null); S.selJunction = null; renderTimeline(); }
  if (e.key === "ArrowLeft" && !S.sel) seek(S.outT - (e.shiftKey ? 5 : 1 / 3));
  if (e.key === "ArrowRight" && !S.sel) seek(S.outT + (e.shiftKey ? 5 : 1 / 3));
});
window.addEventListener("hashchange", () => openProject(location.hash.slice(1)));
window.addEventListener("beforeunload", () => { if (S.dirty) save(); });

async function checkUpdate() {
  try { const u = await api("GET", "/api/update"); const b = $("#updateBtn"); b.hidden = !u.available; if (u.available) b.title = u.message ? "Novedad: " + u.message : ""; } catch (_) {}
}
$("#updateBtn").addEventListener("click", async () => {
  const b = $("#updateBtn"); b.disabled = true; b.textContent = "Actualizando…";
  try {
    await flushSave();
    const r = await api("POST", "/api/update");
    if (!r.updated) { b.hidden = true; toast("Ya tienes la última versión."); return; }
    toast("Listo: " + (r.message || "versión nueva") + ". Reiniciando…", 4000);
    for (let i = 0; i < 40; i++) { await sleep(500); try { const h = await fetch("/api/health"); if (h.ok) { location.reload(); return; } } catch (_) {} }
  } catch (e) { toast("No se pudo actualizar: " + e.message, 6000); b.disabled = false; b.textContent = "Actualización disponible"; }
});
setInterval(checkUpdate, 30 * 60 * 1000);
$("#checkUpdBtn").addEventListener("click", async () => {
  const b = $("#checkUpdBtn"); b.disabled = true; b.textContent = "Buscando…";
  try {
    const u = await api("GET", "/api/update");
    if (!u.configured) toast("Las actualizaciones no están configuradas en esta computadora.", 5000);
    else if (u.error) toast("No pude revisar GitHub: revisa tu internet o el token (menú Reel Studio → Token de GitHub).", 6000);
    else if (u.available) { $("#updateBtn").hidden = false; $("#updateBtn").click(); }
    else toast("Ya tienes la última versión.");
  } catch (e) { toast("No pude buscar actualizaciones: " + e.message, 5000); }
  b.disabled = false; b.textContent = "Buscar actualizaciones";
});

(async function init() {
  S.meta = await api("GET", "/api/meta");
  await Promise.all([loadProjects(), loadBrands()]);
  const id = location.hash.slice(1) || (S.projects[0] && S.projects[0].id);
  if (id) { if (!location.hash) history.replaceState(null, "", "#" + id); await openProject(id); } else render();
  sizeScreen();
  new ResizeObserver(() => { sizeScreen(); renderTimeline(); drawFrame(); }).observe($("#screenWrap"));
  requestAnimationFrame(tick);
  poll(); checkUpdate();
})();
