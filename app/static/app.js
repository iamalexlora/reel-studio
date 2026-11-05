/* Reel Studio — interfaz */
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const FORMATS = { vertical: [1080, 1920, "Vertical 9:16"], horizontal: [1920, 1080, "Horizontal 16:9"], "4:5": [1080, 1350, "Feed 4:5"], cuadrado: [1080, 1080, "Cuadrado 1:1"] };
function geom(fmt, uhd) {
  const f = FORMATS[fmt] || FORMATS.vertical, m = uhd ? 2 : 1, W = f[0] * m, H = f[1] * m, k = Math.min(W, H) / 1080, tall = H > W;
  return { W, H, k, label: f[2], bottom: H * (tall ? 0.224 : 0.085), top: H * (tall ? 0.156 : 0.08), maxw: (tall || W === H) ? W - 180 * k : W * 0.72 };
}
const curFmt = () => (S.P && S.P.settings && S.P.settings.format) || "vertical";
// libass mide la letra por la altura de celda (winAscent+winDescent); CSS por el em.
const FONT_EM = { "Poppins Black": 0.568, "Poppins ExtraBold": 0.568, "Poppins": 0.568, "Anton": 0.577, "Bebas Neue": 0.769 };
const FILLER_LABEL = { "muletilla": "muletilla", "repetición": "repetición", "toma repetida": "toma repetida" };

const S = {
  meta: null, projects: [], P: null, sel: null, anchor: null, history: [],
  segs: [], groups: [], outDur: 0, saving: false, dirty: false, saveTimer: null,
  job: null, lastLogLen: 0, quality: "alta", dragSel: false, raw: false,
};

/* ------------------------------------------------------------ api */
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (!r.ok && r.status !== 409) throw new Error((j && j.error) || `Error ${r.status}`);
  if (r.status === 409) return { __conflict: true, ...j };
  return j;
}
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`; };
const fmtS = (t) => `${Math.round(t)} s`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ------------------------------------------------------------ cortes (igual que engine.py) */
function computeSegments(P) {
  const W = P.words, st = P.settings, dur = P.duration || 1e9;
  const pad = +st.padding, maxPause = st.removeSilences ? +st.maxPause : 1e9;
  const segs = []; let prevKept = null;
  for (let i = 0; i < W.length; i++) {
    const w = W[i]; if (w.cut) continue;
    let s = w.start - pad, e = w.end + pad;
    if (i > 0 && W[i - 1].cut) s = Math.max(s, W[i - 1].end);
    if (i + 1 < W.length && W[i + 1].cut) e = Math.min(e, W[i + 1].start);
    s = Math.max(0, s); e = Math.min(dur, e);
    const adjacent = prevKept !== null && prevKept === i - 1;
    if (segs.length && adjacent && (w.start - W[i - 1].end) <= maxPause) segs[segs.length - 1][1] = Math.max(segs[segs.length - 1][1], e);
    else if (segs.length && s <= segs[segs.length - 1][1]) segs[segs.length - 1][1] = Math.max(segs[segs.length - 1][1], e);
    else segs.push([s, e]);
    prevKept = i;
  }
  return segs.filter(([a, b]) => b - a > 0.04);
}
function mapOut(t) {
  let acc = 0;
  for (const [a, b] of S.segs) { if (t < a) return acc; if (t <= b) return acc + (t - a); acc += b - a; }
  return acc;
}
function mapSrc(o) {
  let acc = 0;
  for (const [a, b] of S.segs) { if (o <= acc + (b - a)) return a + (o - acc); acc += b - a; }
  return S.segs.length ? S.segs[S.segs.length - 1][1] : 0;
}
function captionGroups(P) {
  const st = P.style, out = [];
  const kept = [];
  P.words.forEach((w, i) => {
    if (w.cut) return;
    const s = mapOut(w.start), e = mapOut(w.end);
    if (e - s < 0.02) return;
    kept.push({ i, text: w.text, s, e });
  });
  const maxWords = Math.max(1, +st.maxWords || 3);
  let maxChars = st.size >= 150 ? 16 : (st.box ? 34 : 26);
  if (P.settings.format === "horizontal") maxChars = Math.floor(maxChars * 1.6);
  let cur = [];
  for (const w of kept) {
    if (cur.length) {
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      const last = cur[cur.length - 1];
      if (cur.length >= maxWords || chars > maxChars || w.s - last.e > 0.6 || /[.?!…]$/.test(last.text)) { out.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}
function capText(t, upper) {
  t = t.trim().replace(/[,;:]+$/, "");
  if (!t.endsWith("...")) t = t.replace(/\.$/, "");
  return upper ? t.toUpperCase() : t;
}
function recompute() {
  if (!S.P) return;
  S.segs = computeSegments(S.P);
  S.outDur = S.segs.reduce((n, [a, b]) => n + b - a, 0);
  S.groups = captionGroups(S.P);
  updateDur(); renderTimeline(); renderStats();
}

/* ------------------------------------------------------------ proyectos */
async function loadProjects() {
  S.projects = await api("GET", "/api/projects");
  renderProjects();
}
function renderProjects() {
  const nav = $("#projList");
  if (!S.projects.length) { nav.innerHTML = `<p class="fine" style="padding:0 6px">Todavía no hay proyectos.</p>`; return; }
  nav.innerHTML = S.projects.map((p) => `
    <a href="#${p.id}" class="${S.P && S.P.id === p.id ? "on" : ""}" data-id="${p.id}">
      <button class="del" data-del="${p.id}" title="Borrar proyecto" aria-label="Borrar ${esc(p.name)}">✕</button>
      <span class="pn">${esc(p.name)}</span>
      <span class="pm">${p.status === "listo" ? `${fmtS(p.duration)} → ${fmtS(p.outDuration)}` : esc(p.status || "")}</span>
    </a>`).join("");
}
$("#projList").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]");
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  const p = S.projects.find((x) => x.id === d.dataset.del);
  if (!confirm(`¿Borrar «${p ? p.name : ""}» y sus exportaciones? No se puede deshacer.`)) return;
  await api("DELETE", "/api/projects/" + d.dataset.del);
  if (S.P && S.P.id === d.dataset.del) { S.P = null; location.hash = ""; render(); }
  loadProjects();
});

async function openProject(id, keepTime) {
  if (!id) { S.P = null; render(); return; }
  let P;
  try { P = await api("GET", "/api/projects/" + id); } catch (e) { toast("No encontré ese proyecto."); location.hash = ""; return; }
  const sameProject = S.P && S.P.id === id;
  S.P = P; S.dirty = false;
  if (!sameProject) {
    S.history = []; S.sel = null; S.anchor = null; S.lastLogLen = (P.log || []).length;
    const v = $("#video");
    v.src = `/media/${id}/source`;
    $("#videoBg").src = `/media/${id}/source`;
  }
  const bgKey = id + P.status;
  if (S.bgKey !== bgKey) {
    S.bgKey = bgKey;
    $("#tlStrip").style.backgroundImage = `url(/media/${id}/strip.jpg?s=${encodeURIComponent(P.status)})`;
    $("#tlWave").style.backgroundImage = `url(/media/${id}/wave.png?s=${encodeURIComponent(P.status)})`;
  }
  render();
  if (P.job && (P.status === "transcribiendo" || P.status === "en cola")) watchJob(P.job, "transcribe");
}

/* ------------------------------------------------------------ render general */
function render() {
  const P = S.P;
  $("#emptyState").hidden = !!P;
  $("#workingState").hidden = !(P && P.status !== "listo");
  $("#docState").hidden = !(P && P.status === "listo");
  $("#phoneEmpty").hidden = !!P;
  $("#projTitle").disabled = !P;
  $("#projTitle").value = P ? P.name : "";
  $("#exportBtn").disabled = !(P && P.status === "listo");
  $("#playBtn").disabled = !P;
  $("#undoBtn").disabled = !S.history.length;
  if (!P) { $("#durLabel").textContent = ""; $("#tlCuts").innerHTML = ""; $("#video").removeAttribute("src"); $("#cap").innerHTML = ""; renderProjects(); return; }
  if (P.status === "error") {
    $("#workTitle").textContent = "No se pudo transcribir";
    $("#workMsg").innerHTML = `Revisa que el video tenga audio. <button class="btn small" id="retryBtn">Intentar de nuevo</button>`;
    $("#retryBtn").onclick = async () => { const j = await api("POST", `/api/projects/${P.id}/transcribe`); watchJob(j.id, "transcribe"); };
  }
  recompute();
  renderText(); renderStyle(); renderPace(); renderFormat(); renderLog(); renderProjects(); drawCaption();
}
function updateDur() {
  if (!S.P) return;
  const P = S.P;
  $("#durLabel").innerHTML = P.status === "listo" ? `<b>${fmt(S.outDur)}</b> de ${fmt(P.duration)}` : "";
  $("#tcTotal").textContent = fmt(S.raw ? P.duration : S.outDur);
}

/* ------------------------------------------------------------ texto */
function phrases(W) {
  const out = []; let cur = [];
  W.forEach((w, i) => {
    if (cur.length) {
      const prev = W[cur[cur.length - 1]];
      if (w.start - prev.end > 0.55 || /[.?!…]$/.test(prev.text)) { out.push(cur); cur = []; }
    }
    cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}
function renderText() {
  const P = S.P; if (!P || P.status !== "listo") return;
  const W = P.words, box = $("#text");
  if (!W.length) { box.innerHTML = `<p class="fine">No se detectó voz en este video.</p>`; return; }
  const html = [];
  for (const ph of phrases(W)) {
    const gone = ph.every((i) => W[i].cut);
    html.push(`<p class="ph${gone ? " gone" : ""}"><span class="t" data-seek="${W[ph[0]].start}">${fmt(W[ph[0]].start)}</span>`);
    let lastReason = null;
    for (const i of ph) {
      const w = W[i];
      if (w.cut) {
        const r = w.by === "claude" ? "Claude" : (w.by === "user" ? null : (FILLER_LABEL[w.reason] || w.reason));
        if (r && r !== lastReason) html.push(`<span class="why${w.by === "claude" ? " claude" : ""}" title="${esc(w.reason || "")}">${esc(r)}</span>`);
        lastReason = r;
      } else lastReason = null;
      const cls = ["w"];
      if (w.cut) cls.push("cut");
      else if (w.suggest) cls.push("sug");
      if (w.text !== w.orig) cls.push("fixed");
      if (S.sel && i >= S.sel[0] && i <= S.sel[1]) cls.push("sel");
      const title = w.text !== w.orig ? ` title="Original: ${esc(w.orig)}"` : (w.suggest ? ` title="${esc(w.suggest)}"` : "");
      html.push(`<span class="${cls.join(" ")}" data-i="${i}"${title}>${esc(w.text)}</span> `);
    }
    html.push(`</p>`);
  }
  box.innerHTML = html.join("");
  S.nowEl = null;
  placeSelTools();
}
function wordEl(i) { return $(`#text .w[data-i="${i}"]`); }
function setSel(a, b) {
  if (a == null) { S.sel = null; } else S.sel = [Math.min(a, b), Math.max(a, b)];
  $$("#text .w.sel").forEach((e) => e.classList.remove("sel"));
  if (S.sel) for (let i = S.sel[0]; i <= S.sel[1]; i++) { const e = wordEl(i); if (e) e.classList.add("sel"); }
  placeSelTools();
}
function placeSelTools() {
  const tools = $("#selTools");
  if (!S.sel || !S.P || S.dragSel) { tools.hidden = true; return; }
  const el = wordEl(S.sel[1]); if (!el) { tools.hidden = true; return; }
  const main = $("#main"), r = el.getBoundingClientRect(), m = main.getBoundingClientRect();
  tools.hidden = false;
  const allCut = rangeIdx().every((i) => S.P.words[i].cut);
  tools.querySelector('[data-act="cut"]').hidden = allCut;
  tools.querySelector('[data-act="keep"]').hidden = !rangeIdx().some((i) => S.P.words[i].cut);
  tools.querySelector('[data-act="edit"]').hidden = S.sel[0] !== S.sel[1];
  let left = r.left - m.left + main.scrollLeft;
  left = Math.min(left, main.clientWidth - tools.offsetWidth - 12);
  tools.style.left = Math.max(12, left) + "px";
  const first = wordEl(S.sel[0]).getBoundingClientRect();
  let top = first.top - m.top + main.scrollTop - tools.offsetHeight - 6;
  if (first.top - m.top < tools.offsetHeight + 8) top = r.bottom - m.top + main.scrollTop + 6;
  tools.style.top = top + "px";
}
const rangeIdx = () => { const out = []; if (S.sel) for (let i = S.sel[0]; i <= S.sel[1]; i++) out.push(i); return out; };

const text = $("#text");
text.addEventListener("mousedown", (e) => {
  const t = e.target.closest(".w");
  const ts = e.target.closest("[data-seek]");
  if (ts) { seekSrc(+ts.dataset.seek); return; }
  if (!t) { setSel(null); return; }
  e.preventDefault(); text.focus({ preventScroll: true });
  const i = +t.dataset.i;
  if (e.shiftKey && S.anchor != null) setSel(S.anchor, i);
  else { S.anchor = i; setSel(i, i); }
  S.dragSel = true; S.dragMoved = false; $("#selTools").hidden = true;
});
window.addEventListener("mousemove", (e) => {
  if (!S.dragSel) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const t = hit && hit.closest("#text .w"); if (!t || +t.dataset.i === (S.sel && S.sel[1] === S.anchor ? S.sel[0] : S.sel && S.sel[1])) return;
  S.dragMoved = true; setSel(S.anchor, +t.dataset.i);
});
window.addEventListener("mouseup", (e) => {
  if (!S.dragSel) return;
  S.dragSel = false; placeSelTools();
  if (!S.dragMoved && S.sel && S.sel[0] === S.sel[1] && !e.shiftKey) {
    const w = S.P.words[S.sel[0]];
    seekSrc(w.start, true);
  }
});
text.addEventListener("dblclick", (e) => { const t = e.target.closest(".w"); if (t) editWord(+t.dataset.i); });
$("#selTools").addEventListener("mousedown", (e) => e.preventDefault());
$("#selTools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b || !S.sel) return;
  const act = b.dataset.act;
  if (act === "cut") setCut(rangeIdx(), true);
  if (act === "keep") setCut(rangeIdx(), false);
  if (act === "edit") editWord(S.sel[0]);
  if (act === "play") { const w = S.P.words[S.sel[0]]; S.raw = false; $("#rawToggle").checked = false; seekSrc(Math.max(0, w.start - 0.05), true); play(); }
});
$("#main").addEventListener("scroll", placeSelTools);
window.addEventListener("resize", () => { placeSelTools(); sizePhone(); S.capKey = null; drawCaption(); });

function snapshot() { return JSON.stringify({ w: S.P.words.map((w) => [w.cut, w.by, w.reason, w.text]), st: S.P.style, se: S.P.settings }); }
function pushHistory() { S.history.push(snapshot()); if (S.history.length > 80) S.history.shift(); $("#undoBtn").disabled = false; }
function undo() {
  if (!S.history.length || !S.P) return;
  const h = JSON.parse(S.history.pop());
  h.w.forEach((x, i) => { const w = S.P.words[i]; if (w) [w.cut, w.by, w.reason, w.text] = x; });
  S.P.style = h.st; S.P.settings = h.se;
  $("#undoBtn").disabled = !S.history.length;
  changed(true); renderStyle(); renderPace(); toast("Deshecho");
}
function setCut(idx, cut) {
  if (!idx.length) return;
  pushHistory();
  for (const i of idx) {
    const w = S.P.words[i];
    if (cut) Object.assign(w, { cut: true, by: "user", reason: "quitado a mano" });
    else Object.assign(w, { cut: false, by: "keep", reason: "" });
  }
  changed(true);
}
function editWord(i) {
  const w = S.P.words[i], dlg = $("#editDlg"), inp = $("#editInput");
  inp.value = w.text;
  dlg.returnValue = "";
  dlg.showModal(); inp.select();
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    const v = inp.value.trim();
    if (!v || v === w.text) return;
    pushHistory(); w.text = v; changed(true);
  };
}
$("#editInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#editDlg").close("ok"); } });

function changed(rerenderText) {
  recompute();
  if (rerenderText) renderText();
  drawCaption();
  scheduleSave();
}

/* ------------------------------------------------------------ guardar y sincronizar */
function scheduleSave() {
  S.dirty = true; setSaveState("Guardando…");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 450);
}
async function save() {
  if (!S.P || S.saving) { if (S.saving) S.saveTimer = setTimeout(save, 300); return; }
  S.saving = true; S.dirty = false;
  const P = S.P;
  try {
    const r = await api("PUT", "/api/projects/" + P.id, { rev: P.rev, words: P.words, settings: P.settings, style: P.style, name: P.name });
    if (r.__conflict) {
      S.P = r.current; S.history = [];
      toast("Claude cambió el proyecto mientras editabas; cargué su versión.", 4200);
      render();
    } else { P.rev = r.rev; setSaveState("Guardado"); }
  } catch (e) { setSaveState("Sin guardar"); toast("No pude guardar: " + e.message); S.dirty = true; }
  S.saving = false;
  if (S.dirty) scheduleSave();
}
function setSaveState(t) { $("#saveState").textContent = t; }

async function poll() {
  try {
    if (S.P && !S.dirty && !S.saving) {
      const r = await api("GET", `/api/projects/${S.P.id}/rev`);
      if (r.rev > S.P.rev) {
        const P = await api("GET", "/api/projects/" + S.P.id);
        if (!S.dirty && !S.saving) {
          const hadLog = (S.P.log || []).length;
          S.P = P; render();
          if ((P.log || []).length > hadLog) {
            const last = P.log[P.log.length - 1];
            if (last.who === "claude") { toast("Claude: " + last.text, 4200); $("#logDot").hidden = false; }
          }
          loadProjects();
        }
      }
    }
  } catch (_) {}
  setTimeout(poll, 2000);
}

/* ------------------------------------------------------------ trabajos */
async function watchJob(id, kind) {
  S.job = id;
  const bar = $("#workBar"), meter = bar.parentElement;
  $("#workTitle").textContent = kind === "transcribe" ? "Transcribiendo tu video" : "Procesando";
  while (S.job === id) {
    let j;
    try { j = await api("GET", "/api/jobs/" + id); } catch (_) { break; }
    if (kind === "transcribe" && S.P && j.project === S.P.id) {
      $("#workMsg").textContent = j.message;
      const indet = j.progress <= 0.06 && j.status === "running";
      meter.classList.toggle("indet", indet);
      bar.style.width = (j.progress * 100).toFixed(1) + "%";
    }
    if (j.status !== "running") {
      if (j.status === "error") toast("Error: " + j.error, 6000);
      S.job = null;
      if (S.P) await openProject(S.P.id, true);
      loadProjects();
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

/* ------------------------------------------------------------ subir */
function uploadFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)) { toast("Ese archivo no parece un video. Usa MP4 o MOV."); return; }
  const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 60) || "Mi reel";
  S.P = { id: "_", name, status: "subiendo", words: [], settings: {}, style: {} };
  $("#emptyState").hidden = true; $("#docState").hidden = true; $("#workingState").hidden = false;
  $("#workTitle").textContent = "Copiando el video";
  $("#workMsg").textContent = "0 %";
  $("#workBar").parentElement.classList.remove("indet");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/projects?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const f = e.loaded / e.total; $("#workBar").style.width = (f * 100) + "%"; $("#workMsg").textContent = Math.round(f * 100) + " %"; } };
  xhr.onload = async () => {
    let r; try { r = JSON.parse(xhr.responseText); } catch (_) { r = { error: "respuesta inválida" }; }
    if (xhr.status !== 200 || r.error) { toast(r.error || "No se pudo subir.", 6000); S.P = null; render(); return; }
    S.P = null;
    location.hash = r.project.id;
    await openProject(r.project.id);
    loadProjects();
    if (r.job) watchJob(r.job.id, "transcribe");
  };
  xhr.onerror = () => { toast("Se cortó la subida."); S.P = null; render(); };
  xhr.send(file);
}
["#fileInput", "#fileInput2"].forEach((s) => $(s).addEventListener("change", (e) => { uploadFile(e.target.files[0]); e.target.value = ""; }));
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer.types.includes("Files")) { dragDepth++; $("#app").classList.add("dragging"); } });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#app").classList.remove("dragging"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#app").classList.remove("dragging");
  const f = e.dataTransfer.files[0]; if (f) uploadFile(f);
});

/* ------------------------------------------------------------ reproductor */
const video = $("#video");
function seekSrc(t, quiet) { video.currentTime = Math.max(0, t); if (!quiet) drawCaption(); }
function play() {
  if (!S.P) return;
  if (!S.raw && S.segs.length) {
    const t = video.currentTime, last = S.segs[S.segs.length - 1];
    if (t >= last[1] - 0.05) video.currentTime = S.segs[0][0];
  }
  video.play().catch(() => {});
}
function togglePlay() { if (video.paused) play(); else video.pause(); }
$("#playBtn").addEventListener("click", togglePlay);
video.addEventListener("click", togglePlay);
video.addEventListener("play", () => { $("#playIcon").innerHTML = '<path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" fill="currentColor"/>'; $("#playBtn").setAttribute("aria-label", "Pausar"); });
video.addEventListener("pause", () => { $("#playIcon").innerHTML = '<path d="M6 4l10 6-10 6z" fill="currentColor"/>'; $("#playBtn").setAttribute("aria-label", "Reproducir"); });
video.addEventListener("error", () => {
  if (!S.P || !video.src) return;
  $("#phoneEmpty").hidden = false; $("#phoneEmpty").textContent = "Preparando vista previa…";
  clearTimeout(S.vidRetry);
  S.vidRetry = setTimeout(() => { if (S.P) { video.src = `/media/${S.P.id}/source?r=${Date.now()}`; } }, 4000);
});
video.addEventListener("loadeddata", () => { if (S.P) $("#phoneEmpty").hidden = true; });
$("#rawToggle").addEventListener("change", (e) => { S.raw = e.target.checked; updateDur(); drawCaption(); });

function tick() {
  if (S.P && S.P.status === "listo") {
    let t = video.currentTime;
    if (!video.paused && !S.raw && S.segs.length) {
      let inSeg = false;
      for (let k = 0; k < S.segs.length; k++) {
        const [a, b] = S.segs[k];
        if (t >= a - 0.01 && t < b - 0.015) { inSeg = true; break; }
        if (t < a) { video.currentTime = a; t = a; inSeg = true; break; }
      }
      if (!inSeg) {
        const nxt = S.segs.find(([a]) => a > t + 0.001);
        if (nxt) { video.currentTime = nxt[0]; t = nxt[0]; } else { video.pause(); }
      }
    }
    $("#tcNow").textContent = fmt(S.raw ? t : mapOut(t));
    $("#tlHead").style.left = (100 * t / (S.P.duration || 1)) + "%";
    drawCaption(t);
    highlightNow(t);
  }
  requestAnimationFrame(tick);
}
function highlightNow(t) {
  const W = S.P.words;
  let idx = -1;
  if (!video.paused) {
    for (let i = 0; i < W.length; i++) { if (W[i].start > t) break; if (t <= W[i].end + 0.05) idx = i; }
  }
  if (S.nowIdx === idx) return;
  S.nowIdx = idx;
  if (S.nowEl) S.nowEl.classList.remove("now");
  S.nowEl = idx >= 0 ? wordEl(idx) : null;
  if (S.nowEl) {
    S.nowEl.classList.add("now");
    const m = $("#main"), r = S.nowEl.getBoundingClientRect(), mr = m.getBoundingClientRect();
    if (r.top < mr.top + 60 || r.bottom > mr.bottom - 80) m.scrollTo({ top: m.scrollTop + r.top - mr.top - mr.height / 3, behavior: "smooth" });
  }
}

/* subtítulo en vivo (misma lógica que el render final) */
function drawCaption(tSrc) {
  const cap = $("#cap"), P = S.P;
  if (!P || P.status !== "listo" || !P.settings.subtitles || S.raw) { cap.innerHTML = ""; return; }
  const G = geom(curFmt()), st = P.style, frame = $("#phone"), k = frame.clientWidth / G.W;
  const t = mapOut(tSrc == null ? video.currentTime : tSrc);
  let g = null, gi = -1;
  for (let i = 0; i < S.groups.length; i++) {
    const G = S.groups[i];
    let end = G[G.length - 1].e + 0.25;
    if (i + 1 < S.groups.length) end = Math.min(end, S.groups[i + 1][0].s);
    end = Math.max(end, G[G.length - 1].e);
    if (t >= G[0].s && t < end) { g = G; gi = i; break; }
  }
  const key = g ? gi + ":" + g.findIndex((w, j) => j + 1 >= g.length || t < g[j + 1].s) + ":" + JSON.stringify(st) + frame.clientWidth + curFmt() : "";
  if (key === S.capKey) return;
  S.capKey = key;
  if (!g) { cap.innerHTML = ""; return; }
  let j = g.findIndex((w, jj) => jj + 1 >= g.length || t < g[jj + 1].s);
  cap.innerHTML = captionHTML(g.map((w) => w.text), j, st, k);
  styleCapBox(cap, st, k, G);
}
function captionHTML(words, j, st, k) {
  const mode = st.mode || "resaltar";
  const parts = words.map((w0, idx) => {
    const w = esc(capText(w0, st.uppercase));
    let css = "";
    if (mode === "resaltar") css = idx === j ? `color:${st.highlight};font-size:1.12em;` : `color:${st.color};`;
    else if (mode === "progresivo") css = idx <= j ? `color:${idx === j ? st.highlight : st.color};` : `color:${st.color};opacity:.44;`;
    else { if (idx > j) return ""; css = idx === j ? `color:${st.highlight};animation:pop .11s ease-out;` : `color:${st.color};`; }
    return `<span class="cw" style="${css}">${w}</span>`;
  }).filter(Boolean);
  return `<span class="line">${parts.join(" ")}</span>`;
}
function styleCapBox(cap, st, k, G) {
  k = k * G.k;  // tamaños del estilo están pensados para 1080 de lado corto
  const em = (FONT_EM[st.font] || 0.57) * st.size * k;
  cap.style.fontFamily = `"${st.font}"`;
  cap.style.fontWeight = st.font === "Poppins" ? "700" : "400";
  cap.style.fontSize = em + "px";
  cap.style.letterSpacing = "0";
  const side = (G.W - G.maxw) / 2 / G.W * 100;
  cap.style.left = cap.style.right = side + "%";
  cap.className = "cap" + (st.box ? " box" : "");
  const ow = st.box ? 0 : (+st.outlineWidth || 0) * k * 2;
  cap.style.webkitTextStroke = ow ? `${ow}px ${st.outline}` : "0";
  cap.style.paintOrder = "stroke fill";
  const line = cap.querySelector(".line");
  if (line) {
    line.style.background = st.box ? hexA(st.boxColor, 0.75) : "transparent";
    line.style.padding = st.box ? `${6 * k}px ${18 * k}px` : "0";
  }
  const pos = st.position || "abajo";
  cap.style.top = cap.style.bottom = ""; cap.style.transform = "";
  if (pos === "abajo") cap.style.bottom = (G.bottom / G.H * 100) + "%";
  else if (pos === "arriba") cap.style.top = (G.top / G.H * 100) + "%";
  else { cap.style.top = "50%"; cap.style.transform = "translateY(-50%)"; }
}
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const popStyle = document.createElement("style");
popStyle.textContent = "@keyframes pop{from{transform:scale(.7)}to{transform:scale(1)}}";
document.head.appendChild(popStyle);

/* ------------------------------------------------------------ línea de tiempo */
function renderTimeline() {
  const P = S.P, box = $("#tlCuts");
  if (!P || !P.duration || P.status !== "listo") { box.innerHTML = ""; return; }
  const D = P.duration, cuts = []; let last = 0;
  for (const [a, b] of S.segs) { if (a > last + 0.01) cuts.push([last, a]); last = b; }
  if (last < D - 0.01) cuts.push([last, D]);
  box.innerHTML = cuts.map(([a, b]) => `<div class="tl-cut" style="left:${100 * a / D}%;width:${100 * (b - a) / D}%"></div>`).join("");
}
$("#tlTrack").addEventListener("pointerdown", (e) => {
  if (!S.P) return;
  const r = e.currentTarget.getBoundingClientRect();
  const go = (ev) => seekSrc(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * S.P.duration);
  go(e);
  const mv = (ev) => go(ev), up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
});

/* ------------------------------------------------------------ panel de estilo */
function renderPresets() {
  const box = $("#presets");
  box.innerHTML = Object.entries(S.meta.presets).map(([id, p]) => {
    const k = 0.24;
    const sample = p.uppercase ? "ASÍ SE VE" : "Así se ve";
    const words = sample.split(" ");
    const em = (FONT_EM[p.font] || .57) * p.size * k;
    const stroke = p.box ? "" : `-webkit-text-stroke:${p.outlineWidth * k * 2}px ${p.outline};paint-order:stroke fill;`;
    const inner = words.map((w, i) => {
      const c = p.mode === "progresivo" ? (i < 2 ? p.color : p.color + ";opacity:.44") : (i === 1 ? p.highlight : p.color);
      return `<span style="color:${c}">${w}</span>`;
    }).join(" ");
    const bg = p.box ? `background:${hexA(p.boxColor, .75)};padding:2px 6px;border-radius:3px;` : "";
    return `<button class="preset" data-preset="${id}" title="${esc(p.desc)}">
      <span class="pv"><span style="font-family:'${p.font}';font-weight:${p.font === "Poppins" ? 700 : 400};font-size:${em}px;line-height:1.1;text-align:center;${stroke}${bg}">${inner}</span></span>
      <span class="pl">${esc(p.label)}</span></button>`;
  }).join("");
}
$("#presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]"); if (!b || !S.P) return;
  pushHistory();
  const p = { ...S.meta.presets[b.dataset.preset] }; delete p.label; delete p.desc;
  S.P.style = { ...p, preset: b.dataset.preset };
  renderStyle(); changed(false);
});
function renderStyle() {
  const P = S.P; if (!P || !P.style || !S.meta) return;
  const st = P.style;
  $$(".preset").forEach((b) => b.classList.toggle("on", b.dataset.preset === st.preset));
  $("#subsOn").checked = !!P.settings.subtitles;
  $("#fontSel").value = st.font;
  $("#sizeR").value = st.size; $("#sizeOut").textContent = st.size;
  $("#colText").value = st.color; $("#colHi").value = st.highlight; $("#colOl").value = st.outline; $("#colBox").value = st.boxColor || "#111111";
  $("#colOl").closest(".sw").classList.toggle("off", !!st.box);
  $("#colBox").closest(".sw").classList.toggle("off", !st.box);
  $$("#posSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === st.position));
  $("#wordsR").value = st.maxWords; $("#wordsOut").textContent = st.maxWords;
  $("#upperOn").checked = !!st.uppercase; $("#boxOn").checked = !!st.box;
  $("#olR").value = st.outlineWidth; $("#olOut").textContent = st.outlineWidth;
}
function styleInput(sel, key, conv, ev = "input") {
  let pushed = false;
  $(sel).addEventListener(ev, (e) => {
    if (!S.P) return;
    if (!pushed) { pushHistory(); pushed = true; setTimeout(() => (pushed = false), 800); }
    S.P.style[key] = conv(e.target);
    S.P.style.preset = S.P.style.preset; // se mantiene como base
    renderStyle(); changed(false);
  });
}
styleInput("#fontSel", "font", (t) => t.value, "change");
styleInput("#sizeR", "size", (t) => +t.value);
styleInput("#colText", "color", (t) => t.value.toUpperCase());
styleInput("#colHi", "highlight", (t) => t.value.toUpperCase());
styleInput("#colOl", "outline", (t) => t.value.toUpperCase());
styleInput("#colBox", "boxColor", (t) => t.value.toUpperCase());
styleInput("#wordsR", "maxWords", (t) => +t.value);
styleInput("#upperOn", "uppercase", (t) => t.checked, "change");
styleInput("#boxOn", "box", (t) => t.checked, "change");
styleInput("#olR", "outlineWidth", (t) => +t.value);
$("#posSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || !S.P) return; pushHistory(); S.P.style.position = b.dataset.v; renderStyle(); changed(false); });
$("#subsOn").addEventListener("change", (e) => { if (!S.P) return; pushHistory(); S.P.settings.subtitles = e.target.checked; changed(false); });

/* ------------------------------------------------------------ ritmo */
function renderPace() {
  const P = S.P; if (!P || !P.settings) return;
  const s = P.settings;
  $("#silOn").checked = !!s.removeSilences;
  $("#pauseR").value = s.maxPause; $("#pauseOut").textContent = (+s.maxPause).toFixed(2).replace(".", ",") + " s";
  $("#pauseR").disabled = !s.removeSilences;
  $("#padR").value = s.padding; $("#padOut").textContent = (+s.padding).toFixed(2).replace(".", ",") + " s";
  renderStats();
}
function renderStats() {
  const P = S.P; if (!P || P.status !== "listo") return;
  const by = {}; let cutWords = 0;
  for (const w of P.words) if (w.cut) { cutWords++; const k = w.by === "claude" ? "Claude" : w.by === "user" ? "Tú" : (w.reason || "otro"); by[k] = (by[k] || 0) + 1; }
  const silence = Math.max(0, P.duration - S.outDur);
  $("#stats").innerHTML = `<div><span>Duración final</span><b>${fmt(S.outDur)}</b></div>
    <div><span>Tiempo quitado</span><b>${fmt(silence)}</b></div>
    <div><span>Palabras quitadas</span><b>${cutWords}</b></div>` +
    Object.entries(by).map(([k, v]) => `<div><span>· ${esc(k)}</span><b>${v}</b></div>`).join("");
}
$("#silOn").addEventListener("change", (e) => { if (!S.P) return; pushHistory(); S.P.settings.removeSilences = e.target.checked; renderPace(); changed(false); });
let paceTimer;
["#pauseR", "#padR"].forEach((sel) => $(sel).addEventListener("input", (e) => {
  if (!S.P) return;
  if (!paceTimer) pushHistory();
  clearTimeout(paceTimer); paceTimer = setTimeout(() => (paceTimer = null), 800);
  S.P.settings[sel === "#pauseR" ? "maxPause" : "padding"] = +e.target.value;
  renderPace(); changed(false);
}));
$("#autoBtn").addEventListener("click", async () => {
  if (!S.P) return;
  await flushSave();
  pushHistory();
  const P = await api("POST", `/api/projects/${S.P.id}/autoclean`);
  S.P = P; render();
  const s = P.autoStats || {};
  toast(`Marqué ${s["muletilla"] || 0} muletillas, ${s["repetición"] || 0} repeticiones y ${s["toma repetida"] || 0} palabras de tomas repetidas.`, 4000);
});
async function flushSave() {
  if (S.dirty || S.saving) { clearTimeout(S.saveTimer); while (S.saving) await new Promise((r) => setTimeout(r, 100)); if (S.dirty) await save(); }
}

/* ------------------------------------------------------------ formato y encuadre */
function sizePhone() {
  const G = geom(curFmt()), side = $("#side"), ph = $("#phone");
  const availW = Math.max(160, side.clientWidth - 32), availH = Math.min(window.innerHeight * 0.46, 520);
  const r = G.W / G.H, w = Math.min(availW, availH * r);
  ph.style.width = Math.round(w) + "px"; ph.style.height = Math.round(w / r) + "px";
}
function renderFormat() {
  sizePhone();
  const P = S.P; if (!P || !P.settings) return;
  const s = P.settings, G = geom(s.format), sw = P.width || G.W, sh = P.height || G.H;
  $$("#fmtSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === s.format));
  const srcR = sw / sh, outR = G.W / G.H, same = Math.abs(srcR - outR) < 0.01;
  $("#fitBox").hidden = same;
  $$("#fitSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === s.fit));
  const crop = !same && s.fit === "llenar";
  $("#cropXBox").hidden = !(crop && srcR > outR);
  $("#cropYBox").hidden = !(crop && srcR < outR);
  $("#cropXR").value = s.cropX; $("#cropXOut").textContent = s.cropX < 0.45 ? "izquierda" : s.cropX > 0.55 ? "derecha" : "centro";
  $("#cropYR").value = s.cropY; $("#cropYOut").textContent = s.cropY < 0.45 ? "arriba" : s.cropY > 0.55 ? "abajo" : "centro";
  const v = $("#video"), bg = $("#videoBg");
  const blur = !same && s.fit === "difuminado";
  v.style.objectFit = blur ? "contain" : "cover";
  v.style.objectPosition = `${s.cropX * 100}% ${s.cropY * 100}%`;
  bg.hidden = !blur;
  const fpsTxt = P.fps ? (Number.isInteger(P.fps) ? P.fps : P.fps.toFixed(2).replace(".", ",")) : "?";
  $("#srcInfo").textContent = P.width ? `Tu video original: ${sw}×${sh} · ${fpsTxt} fps${P.hdr ? " · HDR" : ""}` : "";
  S.capKey = null; drawCaption();
}
$("#fmtSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || !S.P) return;
  pushHistory(); S.P.settings.format = b.dataset.v; changed(false); renderFormat();
});
$("#fitSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || !S.P) return;
  pushHistory(); S.P.settings.fit = b.dataset.v; changed(false); renderFormat();
});
["cropX", "cropY"].forEach((key) => {
  let t;
  $("#" + key + "R").addEventListener("input", (e) => {
    if (!S.P) return;
    if (!t) pushHistory();
    clearTimeout(t); t = setTimeout(() => (t = null), 800);
    S.P.settings[key] = +e.target.value; scheduleSave(); renderFormat();
  });
});
const vbg = $("#videoBg");
video.addEventListener("play", () => { if (!vbg.hidden) vbg.play().catch(() => {}); });
video.addEventListener("pause", () => vbg.pause());
video.addEventListener("seeked", () => { if (!vbg.hidden) vbg.currentTime = video.currentTime; });
setInterval(() => { if (!vbg.hidden && Math.abs(vbg.currentTime - video.currentTime) > 0.25) vbg.currentTime = video.currentTime; }, 500);

/* ------------------------------------------------------------ actividad */
function renderLog() {
  const P = S.P; if (!P) return;
  const L = (P.log || []).slice().reverse();
  $("#log").innerHTML = L.length ? L.map((x) => `<li><span class="who ${x.who === "claude" ? "claude" : ""}">${x.who === "claude" ? "Claude" : "Auto"}</span>
    <span>${esc(x.text)}<span class="lt">${new Date(x.t * 1000).toLocaleString("es", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</span></span></li>`).join("")
    : `<li><span></span><span class="fine">Aquí verás lo que la limpieza automática y Claude cambien.</span></li>`;
}

/* ------------------------------------------------------------ pestañas */
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => { x.classList.toggle("on", x === t); x.setAttribute("aria-selected", x === t); });
  $$(".panel").forEach((p) => (p.hidden = p.id !== t.dataset.tab));
  if (t.dataset.tab === "logTab") $("#logDot").hidden = true;
}));

/* ------------------------------------------------------------ exportar */
$("#exportBtn").addEventListener("click", async () => {
  if (!S.P) return;
  await flushSave();
  const P = await api("GET", "/api/projects/" + S.P.id);
  $("#eSubs").checked = !!S.P.settings.subtitles;
  const src = S.P.fps || 30;
  if (!S.exp || S.exp.pid !== S.P.id) S.exp = { pid: S.P.id, fps: src >= 49 ? 60 : (src < 26 ? 24 : 30), uhd: false, codec: "h264", quality: "alta" };
  renderExpOpts();
  $("#expOpts").hidden = false; $("#expProg").hidden = true; $("#expDone").hidden = true; $("#expGo").hidden = false;
  renderExports(P.exports || []);
  $("#exportDlg").showModal();
});
function renderExpOpts() {
  const E = S.exp, P = S.P, G = geom(curFmt(), E.uhd), src = P.fps || 30;
  const canUHD = Math.min(P.width || 0, P.height || 0) >= 1800;
  if (!canUHD) E.uhd = false;
  const mark = (sel, v) => $$(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
  mark("#fpsSeg", E.fps); mark("#resSeg", E.uhd ? 1 : 0); mark("#qSeg", E.quality); mark("#codecSeg", E.codec);
  const uhdBtn = $('#resSeg [data-v="1"]'); uhdBtn.disabled = !canUHD;
  uhdBtn.title = canUHD ? "" : "Tu video original no tiene resolución 4K";
  const srcTxt = Number.isInteger(src) ? src : src.toFixed(2).replace(".", ",");
  $("#fpsNote").innerHTML = E.fps > src + 1
    ? `<span class="warn">Tu video está grabado a ${srcTxt} fps: exportarlo a ${E.fps} no lo hace más fluido, solo más pesado.</span>`
    : `Tu video está grabado a ${srcTxt} fps.`;
  $("#qNote").textContent = { maxima: "La mejor imagen posible. Tarda un poco más en renderizar.", alta: "Excelente para redes, más rápido.", liviana: "Archivo pequeño para enviar o revisar." }[E.quality];
  const codecName = E.codec === "prores" ? "ProRes 422 HQ" : (P.hdr ? "HEVC 10-bit HDR" : "H.264");
  $("#codecNote").textContent = E.codec === "prores"
    ? "Archivo .mov muy pesado, sin pérdida visible: para seguir en Premiere, Final Cut o DaVinci."
    : (P.hdr ? "Tu video es HDR: se exporta en HEVC 10-bit HDR para conservar el color y el brillo del iPhone." : "MP4 listo para Instagram, TikTok y YouTube.");
  $("#expInfo").textContent = `Duración ${fmt(S.outDur)} · ${G.label} · ${G.W}×${G.H} · ${E.fps} fps · ${codecName}`;
  $("#expGo").textContent = `Exportar ${E.codec === "prores" ? "MOV" : "MP4"} ${G.W}×${G.H}`;
}
[["#fpsSeg", "fps", Number], ["#resSeg", "uhd", (v) => v === "1"], ["#qSeg", "quality", String], ["#codecSeg", "codec", String]].forEach(([sel, key, conv]) => {
  $(sel).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; S.exp[key] = conv(b.dataset.v); renderExpOpts(); });
});
$("#expGo").addEventListener("click", async () => {
  const id = S.P.id;
  const opts = { subtitles: $("#eSubs").checked, srt: $("#eSrt").checked, loudnorm: $("#eLoud").checked,
    quality: S.exp.quality, fps: S.exp.fps, uhd: S.exp.uhd, codec: S.exp.codec, format: curFmt() };
  $("#expOpts").hidden = true; $("#expProg").hidden = false; $("#expGo").hidden = true;
  $("#expBar").style.width = "0%";
  const j0 = await api("POST", `/api/projects/${id}/export`, opts);
  while (true) {
    const j = await api("GET", "/api/jobs/" + j0.id);
    $("#expBar").style.width = (j.progress * 100).toFixed(1) + "%";
    $("#expMsg").textContent = `${j.message} ${Math.round(j.progress * 100)} %`;
    if (j.status === "done") {
      $("#expProg").hidden = true; $("#expDone").hidden = false;
      $("#expDoneMsg").textContent = `Listo: ${j.result.file} · ${j.result.size_px} · ${j.result.fps} fps · ${j.result.codec} · ${(j.result.size / 1e6).toFixed(1)} MB`;
      const P = await api("GET", "/api/projects/" + id); renderExports(P.exports || []);
      S.P.rev = Math.max(S.P.rev, P.rev); S.P.log = P.log; renderLog();
      break;
    }
    if (j.status === "error") { $("#expProg").hidden = true; $("#expOpts").hidden = false; $("#expGo").hidden = false; toast("No se pudo exportar: " + j.error, 8000); break; }
    await new Promise((r) => setTimeout(r, 600));
  }
});
function renderExports(list) {
  const id = S.P.id;
  $("#expList").innerHTML = list.length ? `<p class="fine">Exportaciones de este proyecto</p>` + list.map((f) => `
    <div class="ex"><span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span class="a">
      <a href="/media/${id}/export/${encodeURIComponent(f.name)}?dl=1">Descargar</a>
      <button type="button" class="btn small ghost" data-reveal="${esc(f.name)}">Mostrar en Finder</button></span></div>`).join("") : "";
}
$("#expList").addEventListener("click", (e) => { const b = e.target.closest("[data-reveal]"); if (b) api("POST", `/api/projects/${S.P.id}/reveal`, { file: b.dataset.reveal }); });

/* ------------------------------------------------------------ título, teclado, varios */
$("#projTitle").addEventListener("change", (e) => {
  if (!S.P) return; S.P.name = e.target.value.trim() || "Mi reel"; scheduleSave(); setTimeout(loadProjects, 900);
});
$("#undoBtn").addEventListener("click", undo);
$("#railToggle").addEventListener("click", () => {
  const app = $("#app");
  if (window.innerWidth <= 1100) app.classList.toggle("rail-open"); else app.classList.toggle("rail-closed");
});
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (["input", "select", "textarea"].includes(tag) || document.querySelector("dialog[open]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (!S.P || S.P.status !== "listo") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
  if ((e.key === "Backspace" || e.key === "Delete") && S.sel) {
    e.preventDefault();
    const idx = rangeIdx();
    setCut(idx, !idx.every((i) => S.P.words[i].cut));
    return;
  }
  if (e.key === "Escape") { setSel(null); return; }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.sel) {
    e.preventDefault();
    const n = S.P.words.length, d = e.key === "ArrowRight" ? 1 : -1;
    if (e.shiftKey) { const f = (S.sel[1] === S.anchor ? S.sel[0] : S.sel[1]) + d; setSel(S.anchor, Math.max(0, Math.min(n - 1, f))); }
    else { const i = Math.max(0, Math.min(n - 1, (d > 0 ? S.sel[1] : S.sel[0]) + d)); S.anchor = i; setSel(i, i); seekSrc(S.P.words[i].start); }
    const el = wordEl(S.sel[1]); if (el) el.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && S.sel && S.sel[0] === S.sel[1]) { e.preventDefault(); editWord(S.sel[0]); }
});
window.addEventListener("hashchange", () => openProject(location.hash.slice(1)));
window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(); e.preventDefault(); } });

/* ------------------------------------------------------------ actualizaciones */
async function checkUpdate() {
  try {
    const u = await api("GET", "/api/update");
    const b = $("#updateBtn");
    b.hidden = !u.available;
    if (u.available) b.title = u.message ? `Novedad: ${u.message}` : "";
  } catch (_) {}
}
$("#updateBtn").addEventListener("click", async () => {
  const b = $("#updateBtn");
  b.disabled = true; b.textContent = "Actualizando…";
  try {
    await flushSave();
    const r = await api("POST", "/api/update");
    if (!r.updated) { b.hidden = true; toast("Ya tienes la última versión."); return; }
    toast("Listo: " + (r.message || "versión nueva") + ". Reiniciando…", 4000);
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 500));
      try { const h = await fetch("/api/health"); if (h.ok) { location.reload(); return; } } catch (_) {}
    }
  } catch (e) { toast("No se pudo actualizar: " + e.message, 6000); b.disabled = false; b.textContent = "Actualización disponible"; }
});
setInterval(checkUpdate, 30 * 60 * 1000);

(async function init() {
  S.meta = await api("GET", "/api/meta");
  $("#fontSel").innerHTML = S.meta.fonts.map((f) => `<option>${esc(f)}</option>`).join("");
  renderPresets();
  await loadProjects();
  const id = location.hash.slice(1) || (S.projects[0] && S.projects[0].id);
  if (id) { if (!location.hash) history.replaceState(null, "", "#" + id); await openProject(id); }
  else render();
  const running = await api("GET", "/api/jobs");
  for (const j of running) if (S.P && j.project === S.P.id && j.kind === "transcribe") watchJob(j.id, "transcribe");
  requestAnimationFrame(tick);
  poll();
  checkUpdate();
})();
