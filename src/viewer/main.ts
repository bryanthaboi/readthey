import { marked } from "marked";
import mermaid from "mermaid";

const THEME_KEY = "readthey-theme";
const THEMES = ["paper", "midnight", "sepia", "signal"] as const;
type ThemeId = (typeof THEMES)[number];

interface DocRef {
  id: string;
  path: string;
  repoRoot: string | null;
  repoLabel: string;
  title: string;
  addedAt: string;
  parentDocId?: string | null;
}

interface SessionPayload {
  theme: ThemeId;
  activeDocId: string | null;
  documents: DocRef[];
}

let sessionCache: SessionPayload | null = null;
let currentDocPath = "";
let currentDocId = "";
/** Set while `marked.parse` runs so the image renderer can build asset URLs. */
let renderContextDocId = "";
let selectedRepo: "all" | string = "all";
let searchQuery = "";

const LS_SEARCH_CASE = "readthey-search-case";
const LS_SEARCH_REGEX = "readthey-search-regex";
const LS_TREE_COLLAPSED = "readthey-tree-collapsed";
const LS_REPO_ACCESS = "readthey-repo-access";

let searchCaseSensitive = localStorage.getItem(LS_SEARCH_CASE) === "1";
let searchRegex = localStorage.getItem(LS_SEARCH_REGEX) === "1";
/** When query non-empty: ids that match (after server search). */
let searchHitIds: Set<string> | null = null;
let searchLoading = false;
let searchPending = false;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

function repoKey(d: DocRef): string {
  return d.repoRoot ?? "__local__";
}

function getStoredTheme(): ThemeId {
  const t = localStorage.getItem(THEME_KEY);
  if (t && (THEMES as readonly string[]).includes(t)) return t as ThemeId;
  return "paper";
}

function mermaidConfigFor(theme: ThemeId): void {
  const dark = theme === "midnight" || theme === "signal";
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "neutral",
    securityLevel: "strict",
    fontFamily: "ui-monospace, SF Mono, Menlo, Monaco, Consolas, monospace",
    themeVariables: dark
      ? {
          primaryColor: "#1a1d26",
          primaryTextColor: "#e8eaef",
          lineColor: "#9aa3b2",
          secondaryColor: "#12141c",
          tertiaryColor: "#07080c",
        }
      : {
          primaryColor: "#ebe7dd",
          primaryTextColor: "#0a0a0a",
          lineColor: "#3d3d3d",
          secondaryColor: "#e8e4da",
          tertiaryColor: "#f4f2ec",
        },
  });
}

/** Renders each diagram separately so one bad block cannot break the rest of the page (e.g. sidebar refresh). */
async function runMermaidSafe(root: HTMLElement): Promise<void> {
  const nodes = [...root.querySelectorAll(".mermaid")];
  for (const el of nodes) {
    if (el.hasAttribute("data-processed")) continue;
    try {
      await mermaid.run({ nodes: [el] });
    } catch (err) {
      const wrap = el.closest(".mermaid-wrap");
      wrap?.classList.add("mermaid-failed");
      el.removeAttribute("data-processed");
      const msg = err instanceof Error ? err.message : String(err);
      el.innerHTML = "";
      const div = document.createElement("div");
      div.className = "mermaid-error";
      div.setAttribute("role", "alert");
      div.textContent = `This diagram could not be rendered. ${msg}`;
      el.appendChild(div);
    }
  }
  syncMermaidToolbarVisibility(root);
}

function syncMermaidToolbarVisibility(root: HTMLElement): void {
  root.querySelectorAll(".mermaid-wrap").forEach((w) => {
    const tb = w.querySelector(".mermaid-toolbar") as HTMLElement | null;
    if (tb) tb.hidden = !w.querySelector("svg");
  });
}

const MERMAID_FS_ID = "mermaid-fullscreen-root";
let mermaidFsCleanup: (() => void) | null = null;

function ensureMermaidFullscreenRoot(): HTMLElement {
  let el = document.getElementById(MERMAID_FS_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = MERMAID_FS_ID;
  el.className = "mermaid-fullscreen-root";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Diagram viewer");
  el.hidden = true;
  el.innerHTML = `
    <div class="mermaid-fs-chrome">
      <button type="button" class="mermaid-fs-close" aria-label="Close fullscreen">Close</button>
      <button type="button" class="mermaid-fs-reset" aria-label="Reset pan and zoom">Reset</button>
      <span class="mermaid-fs-hint">Drag to pan · wheel to zoom</span>
    </div>
    <div class="mermaid-fs-viewport"></div>
  `;
  document.body.appendChild(el);
  return el;
}

function closeMermaidFullscreen(): void {
  const root = document.getElementById(MERMAID_FS_ID);
  if (root) {
    root.hidden = true;
    root.querySelector(".mermaid-fs-viewport")?.replaceChildren();
  }
  mermaidFsCleanup?.();
  mermaidFsCleanup = null;
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  }
}

/** Pad viewBox so its aspect matches the viewport (no letterboxing; 1:1 pointer mapping). */
function expandViewBoxToViewportAspect(
  bx: number,
  by: number,
  bw: number,
  bh: number,
  pw: number,
  ph: number,
): { x: number; y: number; w: number; h: number } {
  if (bw <= 0 || bh <= 0 || pw <= 0 || ph <= 0) {
    return { x: bx, y: by, w: bw, h: bh };
  }
  const chartAR = bw / bh;
  const portAR = pw / ph;
  let cx = bx;
  let cy = by;
  let cw = bw;
  let ch = bh;
  if (chartAR > portAR) {
    const newH = cw / portAR;
    cy -= (newH - ch) / 2;
    ch = newH;
  } else {
    const newW = ch * portAR;
    cx -= (newW - cw) / 2;
    cw = newW;
  }
  return { x: cx, y: cy, w: cw, h: ch };
}

function openMermaidFullscreen(wrap: HTMLElement): void {
  const src = wrap.querySelector("svg");
  if (!src || !(src instanceof SVGSVGElement)) return;

  const root = ensureMermaidFullscreenRoot();
  const viewport = root.querySelector(".mermaid-fs-viewport") as HTMLElement | null;
  if (!viewport) return;

  closeMermaidFullscreen();

  const svgEl = src.cloneNode(true) as SVGSVGElement;
  svgEl.removeAttribute("style");
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  svgEl.style.display = "block";
  viewport.replaceChildren(svgEl);

  let vbX = 0;
  let vbY = 0;
  let vbW = 100;
  let vbH = 100;
  let initialVb = { x: 0, y: 0, w: 100, h: 100 };

  function viewportSize(): { w: number; h: number } {
    const r = viewport.getBoundingClientRect();
    return { w: Math.max(r.width, 1), h: Math.max(r.height, 1) };
  }

  function syncSvgPixelSize(): void {
    const { w, h } = viewportSize();
    svgEl.setAttribute("width", String(Math.round(w)));
    svgEl.setAttribute("height", String(Math.round(h)));
  }

  function applyViewBox(): void {
    svgEl.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }

  function readDiagramBounds(): { x: number; y: number; w: number; h: number } {
    try {
      const b = svgEl.getBBox();
      if (b.width > 0 && b.height > 0) {
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      }
    } catch {
      /* ignore */
    }
    const vb = svgEl.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    }
    return { x: 0, y: 0, w: 400, h: 300 };
  }

  function fitInitial(): void {
    syncSvgPixelSize();
    const b = readDiagramBounds();
    const pad = Math.max(b.w, b.h) * 0.04;
    const bx = b.x - pad;
    const by = b.y - pad;
    const bw = b.w + pad * 2;
    const bh = b.h + pad * 2;
    const { w: pw, h: ph } = viewportSize();
    const exp = expandViewBoxToViewportAspect(bx, by, bw, bh, pw, ph);
    vbX = exp.x;
    vbY = exp.y;
    vbW = exp.w;
    vbH = exp.h;
    initialVb = { x: vbX, y: vbY, w: vbW, h: vbH };
    applyViewBox();
  }

  function resetView(): void {
    vbX = initialVb.x;
    vbY = initialVb.y;
    vbW = initialVb.w;
    vbH = initialVb.h;
    syncSvgPixelSize();
    applyViewBox();
  }

  root.hidden = false;

  const ac = new AbortController();
  const { signal } = ac;

  const ro = new ResizeObserver(() => {
    syncSvgPixelSize();
  });
  ro.observe(viewport);

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const W = Math.max(rect.width, 1);
    const H = Math.max(rect.height, 1);
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const sx = vbX + (mx / W) * vbW;
    const sy = vbY + (my / H) * vbH;
    const zoomOut = e.deltaY > 0;
    const factor = zoomOut ? 1.12 : 1 / 1.12;
    const ar = vbW / vbH;
    let nW = vbW * factor;
    const minW = Math.max(initialVb.w / 80, 1e-6);
    const maxW = initialVb.w * 80;
    nW = Math.min(maxW, Math.max(minW, nW));
    const nH = nW / ar;
    vbX = sx - (mx / W) * nW;
    vbY = sy - (my / H) * nH;
    vbW = nW;
    vbH = nH;
    applyViewBox();
  };

  let drag = false;
  let lx = 0;
  let ly = 0;
  const onDown = (e: PointerEvent): void => {
    if ((e.target as HTMLElement).closest(".mermaid-fs-chrome")) return;
    drag = true;
    lx = e.clientX;
    ly = e.clientY;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag) return;
    const rect = viewport.getBoundingClientRect();
    const W = Math.max(rect.width, 1);
    const H = Math.max(rect.height, 1);
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    vbX -= (dx / W) * vbW;
    vbY -= (dy / H) * vbH;
    applyViewBox();
  };
  const endDrag = (e: PointerEvent): void => {
    drag = false;
    viewport.style.cursor = "";
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  viewport.addEventListener("wheel", onWheel, { passive: false, signal });
  viewport.addEventListener("pointerdown", onDown, { signal });
  viewport.addEventListener("pointermove", onMove, { signal });
  viewport.addEventListener("pointerup", endDrag, { signal });
  viewport.addEventListener("pointercancel", endDrag, { signal });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMermaidFullscreen();
    }
  };
  document.addEventListener("keydown", onKey, { signal });

  root.querySelector(".mermaid-fs-close")?.addEventListener("click", () => closeMermaidFullscreen(), { signal });
  root.querySelector(".mermaid-fs-reset")?.addEventListener("click", () => resetView(), { signal });

  const onThisFsChange = (): void => {
    if (document.fullscreenElement === root) {
      requestAnimationFrame(() => requestAnimationFrame(fitInitial));
    }
  };
  document.addEventListener("fullscreenchange", onThisFsChange, { signal });

  mermaidFsCleanup = () => {
    ro.disconnect();
    ac.abort();
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(fitInitial);
  });

  void root.requestFullscreen?.().catch(() => {});
}

function wireMermaidFullscreenDelegation(): void {
  document.body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest(".mermaid-fs-btn");
    if (!btn) return;
    const wrap = btn.closest(".mermaid-wrap");
    const content = document.getElementById("content");
    if (!wrap || !content?.contains(wrap)) return;
    e.preventDefault();
    e.stopPropagation();
    openMermaidFullscreen(wrap as HTMLElement);
  });
}

marked.use({
  renderer: {
    code(token) {
      if (token.lang === "mermaid") {
        const id =
          "m-" +
          Math.random().toString(36).slice(2, 10) +
          Math.random().toString(36).slice(2, 10);
        return `<div class="mermaid-wrap"><div class="mermaid-toolbar"><button type="button" class="mermaid-fs-btn" title="Fullscreen — pan &amp; zoom" aria-label="Open diagram fullscreen"><span class="mermaid-fs-icon" aria-hidden="true">⛶</span></button></div><div class="mermaid-inner"><div id="${id}" class="mermaid">${escapeHtml(token.text)}</div></div></div>`;
      }
      const lang = token.lang ? escapeHtml(token.lang) : "";
      return `<pre><code class="language-${lang}">${escapeHtml(token.text)}</code></pre>`;
    },
    image(token) {
      const src = token.href;
      const alt = escapeHtml(token.text);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      const t = src.trim();
      if (/^https?:\/\//i.test(t) || t.startsWith("data:")) {
        return `<img src="${escapeHtml(src)}" alt="${alt}"${title} loading="lazy" />`;
      }
      const docId = renderContextDocId;
      if (!docId) {
        return `<img src="${escapeHtml(src)}" alt="${alt}"${title} loading="lazy" />`;
      }
      const q = encodeURIComponent(src);
      return `<img src="/api/documents/${encodeURIComponent(docId)}/asset?path=${q}" alt="${alt}"${title} loading="lazy" />`;
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rewrite relative <img src> from raw HTML blocks to proxied asset URLs. */
function rewriteRelativeMedia(root: HTMLElement, docId: string): void {
  root.querySelectorAll("img[src]").forEach((node) => {
    const img = node as HTMLImageElement;
    const src = img.getAttribute("src");
    if (!src) return;
    const t = src.trim();
    if (/^https?:\/\//i.test(t) || t.startsWith("data:") || t.startsWith("/api/documents/")) return;
    img.setAttribute("src", `/api/documents/${encodeURIComponent(docId)}/asset?path=${encodeURIComponent(t)}`);
    if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
  });
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    const id = (btn as HTMLElement).dataset.theme as ThemeId;
    btn.setAttribute("aria-pressed", String(id === theme));
  });
  mermaidConfigFor(theme);
}

async function persistTheme(theme: ThemeId): Promise<void> {
  applyTheme(theme);
  await fetch("/api/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  });
  sessionCache = await fetchSession();
}

async function fetchSession(): Promise<SessionPayload> {
  const r = await fetch("/api/session", { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as SessionPayload;
}

function repoGroups(docs: DocRef[]): { key: string; label: string }[] {
  const m = new Map<string, string>();
  for (const d of docs) {
    const key = repoKey(d);
    if (!m.has(key)) m.set(key, d.repoLabel);
  }
  return Array.from(m.entries()).map(([key, label]) => ({ key, label }));
}

function loadRepoAccess(): Map<string, number> {
  try {
    const raw = localStorage.getItem(LS_REPO_ACCESS);
    if (!raw) return new Map();
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return new Map();
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number" && Number.isFinite(v)) m.set(k, v);
    }
    return m;
  } catch {
    return new Map();
  }
}

function saveRepoAccess(m: Map<string, number>): void {
  localStorage.setItem(LS_REPO_ACCESS, JSON.stringify(Object.fromEntries(m)));
}

function touchRepoAccess(key: string): void {
  if (!key) return;
  const m = loadRepoAccess();
  m.set(key, Date.now());
  saveRepoAccess(m);
}

/** Repo filter tabs / datalist: newest interaction first, then label. */
function repoGroupsByRecent(docs: DocRef[]): { key: string; label: string }[] {
  const groups = repoGroups(docs);
  const access = loadRepoAccess();
  return groups.sort((a, b) => {
    const ta = access.get(a.key) ?? 0;
    const tb = access.get(b.key) ?? 0;
    if (ta !== tb) return tb - ta;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

function touchRepoForDocId(docId: string): void {
  const d = sessionCache?.documents.find((x) => x.id === docId);
  if (d) touchRepoAccess(repoKey(d));
}

function filteredDocs(docs: DocRef[]): DocRef[] {
  const q = searchQuery.trim();
  return docs.filter((d) => {
    if (selectedRepo !== "all" && repoKey(d) !== selectedRepo) return false;
    if (!q) return true;
    if (searchPending || searchLoading) return false;
    if (searchHitIds === null) return false;
    return searchHitIds.has(d.id);
  });
}

function setSearchError(msg: string | null): void {
  const el = document.getElementById("search-error");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function syncSearchToggleButtons(): void {
  document.getElementById("search-case")?.setAttribute("aria-pressed", String(searchCaseSensitive));
  document.getElementById("search-regex")?.setAttribute("aria-pressed", String(searchRegex));
}

function paintDocList(): void {
  if (sessionCache) renderDocList(sessionCache.documents);
}

function scheduleSearch(): void {
  clearTimeout(searchDebounce);
  const q = searchQuery.trim();
  if (!q) {
    searchPending = false;
    searchLoading = false;
    searchHitIds = null;
    setSearchError(null);
    paintDocList();
    return;
  }
  searchPending = true;
  searchHitIds = null;
  setSearchError(null);
  paintDocList();
  searchDebounce = setTimeout(() => void runSearchRequest(), 280);
}

async function runSearchRequest(): Promise<void> {
  const q = searchQuery.trim();
  if (!q) {
    searchPending = false;
    searchLoading = false;
    searchHitIds = null;
    paintDocList();
    return;
  }
  searchPending = false;
  searchLoading = true;
  paintDocList();
  const params = new URLSearchParams({ q });
  if (searchRegex) params.set("regex", "1");
  if (searchCaseSensitive) params.set("case", "1");
  try {
    const r = await fetch(`/api/search?${params.toString()}`, { cache: "no-store" });
    const data = (await r.json()) as { ids?: string[]; error?: string };
    if (searchQuery.trim() !== q) return;
    if (!r.ok) {
      searchHitIds = new Set();
      setSearchError(data.error ?? "Search failed");
      searchLoading = false;
      paintDocList();
      return;
    }
    setSearchError(null);
    searchHitIds = new Set(data.ids ?? []);
    searchLoading = false;
    paintDocList();
  } catch {
    if (searchQuery.trim() !== q) return;
    searchHitIds = new Set();
    setSearchError("Search failed");
    searchLoading = false;
    paintDocList();
  }
}

function renderDatalist(docs: DocRef[]): void {
  const dl = document.getElementById("repo-options");
  if (!dl) return;
  dl.innerHTML = "";
  const groups = repoGroupsByRecent(docs);
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.label;
    opt.label = g.label;
    dl.appendChild(opt);
  }
}

function dirnameFs(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "" : p.slice(0, i);
}

function normalizePathSep(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function splitPathParts(abs: string): string[] {
  return normalizePathSep(abs)
    .split("/")
    .filter((s) => s.length > 0);
}

/** Longest common directory prefix for absolute paths (segment-wise, case-insensitive). */
function longestCommonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const dirLists = paths.map((p) => splitPathParts(dirnameFs(p)));
  if (dirLists.some((d) => d.length === 0)) return "";
  const first = dirLists[0]!;
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (!dirLists.every((d) => i < d.length && d[i]!.toLowerCase() === seg.toLowerCase())) break;
    out.push(seg);
  }
  if (out.length === 0) return "";
  return out[0]!.includes(":") ? out.join("/") : `/${out.join("/")}`;
}

/** Path from base dir to file, using / (filename included). */
function relativePathFromBase(baseAbs: string | null, fileAbs: string): string {
  if (baseAbs) {
    const root = normalizePathSep(baseAbs).replace(/\/$/, "");
    const file = normalizePathSep(fileAbs);
    const rl = root.toLowerCase();
    const fl = file.toLowerCase();
    const pre = rl + "/";
    if (fl === rl) return basename(fileAbs);
    if (fl.startsWith(pre)) {
      return file.slice(pre.length);
    }
  }
  const parts = splitPathParts(fileAbs);
  return parts.join("/") || basename(fileAbs);
}

function baseRootForDocGroup(d: DocRef, group: DocRef[]): string | null {
  if (d.repoRoot) return d.repoRoot;
  return longestCommonDirPrefix(group.map((x) => x.path)) || null;
}

function repoWrapperNeededForList(list: DocRef[]): boolean {
  if (selectedRepo !== "all") return false;
  const keys = new Set(list.map(repoKey));
  return keys.size > 1;
}

function repoCollapseKey(rk: string): string {
  return `repo:${rk}`;
}

function folderCollapseKey(rk: string, relDir: string): string {
  return `fld:${rk}:${relDir}`;
}

interface FolderTrie {
  subfolders: Map<string, FolderTrie>;
  docs: DocRef[];
}

function emptyTrie(): FolderTrie {
  return { subfolders: new Map(), docs: [] };
}

function insertDocIntoTrie(trie: FolderTrie, relFilePath: string, doc: DocRef): void {
  const parts = relFilePath.split("/").filter(Boolean);
  if (parts.length === 0) {
    trie.docs.push(doc);
    return;
  }
  parts.pop();
  let cur = trie;
  for (const seg of parts) {
    if (!cur.subfolders.has(seg)) cur.subfolders.set(seg, emptyTrie());
    cur = cur.subfolders.get(seg)!;
  }
  cur.docs.push(doc);
}

function sortDocsByPath(ds: DocRef[]): void {
  ds.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

function sortedSubfolders(m: Map<string, FolderTrie>): [string, FolderTrie][] {
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function buildTrieForDocGroup(group: DocRef[]): FolderTrie {
  const root = emptyTrie();
  if (group.length === 0) return root;
  const sample = group[0]!;
  const base = baseRootForDocGroup(sample, group);
  for (const d of group) {
    const rel = relativePathFromBase(base, d.path);
    insertDocIntoTrie(root, rel, d);
  }
  return root;
}

/** Expand every folder segment + repo wrapper on path to `d` so the active file is visible. */
function expandFolderAncestors(activeId: string, list: DocRef[], collapsed: Set<string>): void {
  const d = list.find((x) => x.id === activeId);
  if (!d) return;
  const rk = repoKey(d);
  const group = list.filter((x) => repoKey(x) === rk);
  const base = baseRootForDocGroup(d, group);
  const rel = relativePathFromBase(base, d.path);
  const parts = rel.split("/").filter(Boolean);
  if (repoWrapperNeededForList(list)) {
    collapsed.delete(repoCollapseKey(rk));
  }
  if (parts.length <= 1) return;
  const dirSegs = parts.slice(0, -1);
  let acc = "";
  for (const seg of dirSegs) {
    acc = acc ? `${acc}/${seg}` : seg;
    collapsed.delete(folderCollapseKey(rk, acc));
  }
}

function renderFolderTrie(
  trie: FolderTrie,
  repoKeyStr: string,
  relPrefix: string,
  collapsed: Set<string>,
  ul: HTMLElement,
): void {
  for (const [name, childTrie] of sortedSubfolders(trie.subfolders)) {
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const fkey = folderCollapseKey(repoKeyStr, rel);
    const hasKids = childTrie.subfolders.size > 0 || childTrie.docs.length > 0;
    const isCollapsed = hasKids && collapsed.has(fkey);

    const li = document.createElement("li");
    li.className = "doc-item doc-tree-node doc-folder-node";

    const row = document.createElement("div");
    row.className = "doc-item-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-toggle";
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.setAttribute("aria-label", isCollapsed ? "Expand folder" : "Collapse folder");
    btn.textContent = isCollapsed ? "▸" : "▾";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const set = getCollapsedSet();
      if (set.has(fkey)) set.delete(fkey);
      else set.add(fkey);
      saveCollapsedSet(set);
      if (sessionCache) renderDocList(sessionCache.documents);
    });
    row.appendChild(btn);

    const lab = document.createElement("span");
    lab.className = "folder-label";
    lab.textContent = name;
    row.appendChild(lab);

    li.appendChild(row);

    const childUl = document.createElement("ul");
    childUl.className = "doc-tree-children";
    if (isCollapsed) childUl.hidden = true;
    renderFolderTrie(childTrie, repoKeyStr, rel, collapsed, childUl);
    li.appendChild(childUl);
    ul.appendChild(li);
  }

  sortDocsByPath(trie.docs);
  for (const d of trie.docs) {
    const li = document.createElement("li");
    li.className = "doc-item doc-tree-node doc-file-node";
    const row = document.createElement("div");
    row.className = "doc-item-row";
    const sp = document.createElement("span");
    sp.className = "tree-spacer";
    sp.setAttribute("aria-hidden", "true");
    row.appendChild(sp);
    appendOpenRemove(row, d);
    li.appendChild(row);
    ul.appendChild(li);
  }
}

function renderFolderForest(list: DocRef[], collapsed: Set<string>, ul: HTMLElement): void {
  const byRepo = new Map<string, DocRef[]>();
  for (const d of list) {
    const k = repoKey(d);
    if (!byRepo.has(k)) byRepo.set(k, []);
    byRepo.get(k)!.push(d);
  }
  const entries = [...byRepo.entries()].sort(([, ga], [, gb]) => {
    const la = ga[0]?.repoLabel ?? "";
    const lb = gb[0]?.repoLabel ?? "";
    return la.localeCompare(lb, undefined, { sensitivity: "base" });
  });

  const wrapRepo = repoWrapperNeededForList(list);

  for (const [rk, group] of entries) {
    const trie = buildTrieForDocGroup(group);
    if (wrapRepo) {
      const rkey = repoCollapseKey(rk);
      const hasAny = trie.subfolders.size > 0 || trie.docs.length > 0;
      const repoCollapsed = hasAny && collapsed.has(rkey);

      const li = document.createElement("li");
      li.className = "doc-item doc-tree-node doc-folder-node doc-repo-node";

      const row = document.createElement("div");
      row.className = "doc-item-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-toggle";
      btn.setAttribute("aria-expanded", repoCollapsed ? "false" : "true");
      btn.setAttribute("aria-label", repoCollapsed ? "Expand repository" : "Collapse repository");
      btn.textContent = repoCollapsed ? "▸" : "▾";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const set = getCollapsedSet();
        if (set.has(rkey)) set.delete(rkey);
        else set.add(rkey);
        saveCollapsedSet(set);
        if (sessionCache) renderDocList(sessionCache.documents);
      });
      row.appendChild(btn);

      const lab = document.createElement("span");
      lab.className = "folder-label repo-label";
      lab.textContent = group[0]?.repoLabel ?? rk;
      row.appendChild(lab);

      li.appendChild(row);

      const childUl = document.createElement("ul");
      childUl.className = "doc-tree-children";
      if (repoCollapsed) childUl.hidden = true;
      renderFolderTrie(trie, rk, "", collapsed, childUl);
      li.appendChild(childUl);
      ul.appendChild(li);
    } else {
      renderFolderTrie(trie, rk, "", collapsed, ul);
    }
  }
}

function getCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_TREE_COLLAPSED);
    if (!raw) return new Set();
    const a = JSON.parse(raw) as unknown;
    if (!Array.isArray(a)) return new Set();
    return new Set(a.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedSet(s: Set<string>): void {
  localStorage.setItem(LS_TREE_COLLAPSED, JSON.stringify([...s]));
}

function appendOpenRemove(row: HTMLElement, d: DocRef): void {
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "doc-link";
  openBtn.setAttribute("aria-current", d.id === currentDocId ? "true" : "false");
  const tspan = document.createElement("span");
  tspan.className = "doc-title";
  tspan.textContent = d.title;
  const mspan = document.createElement("span");
  mspan.className = "doc-meta";
  mspan.textContent = `${d.repoLabel} · ${basename(d.path)}`;
  openBtn.appendChild(tspan);
  openBtn.appendChild(mspan);
  openBtn.addEventListener("click", () => void selectDoc(d.id));
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "btn-remove-ref";
  rm.title = "Remove from library (does not delete file)";
  rm.textContent = "×";
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    void removeRef(d.id);
  });
  row.appendChild(openBtn);
  row.appendChild(rm);
}

function renderRepoTabs(docs: DocRef[]): void {
  const el = document.getElementById("repo-tabs");
  if (!el) return;
  el.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "repo-tab";
  allBtn.textContent = "All";
  allBtn.setAttribute("role", "tab");
  allBtn.setAttribute("aria-selected", String(selectedRepo === "all"));
  allBtn.addEventListener("click", () => {
    selectedRepo = "all";
    const ta = document.getElementById("repo-typeahead") as HTMLInputElement | null;
    if (ta) ta.value = "";
    void refreshUI();
  });
  el.appendChild(allBtn);

  for (const g of repoGroupsByRecent(docs)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "repo-tab";
    b.textContent = g.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(selectedRepo === g.key));
    b.dataset.repoKey = g.key;
    b.addEventListener("click", () => {
      touchRepoAccess(g.key);
      selectedRepo = g.key;
      const ta = document.getElementById("repo-typeahead") as HTMLInputElement | null;
      if (ta) ta.value = g.label;
      void refreshUI();
    });
    el.appendChild(b);
  }

  queueMicrotask(() => {
    el.querySelector(".repo-tab[aria-selected=\"true\"]")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  });
}

function renderDocList(docs: DocRef[]): void {
  const ul = document.getElementById("doc-list");
  if (!ul) return;
  ul.innerHTML = "";
  const list = filteredDocs(docs);
  const q = searchQuery.trim();
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "doc-item";
    if (q && (searchLoading || searchPending)) li.textContent = "Searching…";
    else li.textContent = "No documents match.";
    ul.appendChild(li);
    return;
  }
  if (q) {
    const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    for (const d of sorted) {
      const li = document.createElement("li");
      li.className = "doc-item doc-item-flat";
      const row = document.createElement("div");
      row.className = "doc-item-row";
      appendOpenRemove(row, d);
      li.appendChild(row);
      ul.appendChild(li);
    }
    return;
  }
  const collapsed = getCollapsedSet();
  if (currentDocId) expandFolderAncestors(currentDocId, list, collapsed);
  saveCollapsedSet(collapsed);
  renderFolderForest(list, collapsed, ul);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

async function removeRef(id: string): Promise<void> {
  const r = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) return;
  sessionCache = await fetchSession();
  if (currentDocId === id) {
    const next = sessionCache.documents[0]?.id;
    if (next) await selectDoc(next);
    else {
      currentDocId = "";
      currentDocPath = "";
      const content = document.getElementById("content");
      if (content) content.innerHTML = "";
      const miss = document.getElementById("missing-banner");
      if (miss) {
        miss.hidden = true;
        miss.innerHTML = "";
      }
      history.replaceState(null, "", "/");
    }
  }
  await refreshUI();
}

async function refreshUI(): Promise<void> {
  if (!sessionCache) sessionCache = await fetchSession();
  renderDatalist(sessionCache.documents);
  renderRepoTabs(sessionCache.documents);
  const q = searchQuery.trim();
  if (q) {
    await runSearchRequest();
  } else {
    renderDocList(sessionCache.documents);
  }
}

async function selectDoc(id: string): Promise<void> {
  const status = document.getElementById("status");
  const content = document.getElementById("content");
  const miss = document.getElementById("missing-banner");
  if (!content || !status) return;

  status.textContent = "Loading…";
  if (miss) {
    miss.hidden = true;
    miss.innerHTML = "";
  }

  await fetch("/api/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activeDocId: id }),
  });

  const r = await fetch(`/api/documents/${encodeURIComponent(id)}/content`, { cache: "no-store" });
  if (!r.ok) {
    status.textContent = String(r.status);
    return;
  }
  const data = (await r.json()) as {
    id: string;
    path: string;
    missing: boolean;
    markdown: string;
  };

  currentDocId = data.id;
  currentDocPath = data.path;
  history.replaceState(null, "", `/?doc=${encodeURIComponent(id)}`);

  if (data.missing) {
    content.innerHTML = "";
    status.textContent = "";
    sessionCache = await fetchSession();
    touchRepoForDocId(id);
    if (miss) {
      miss.hidden = false;
      miss.innerHTML = `This file is no longer on disk. <button type="button" id="btn-remove-missing">Remove reference</button>`;
      document.getElementById("btn-remove-missing")?.addEventListener("click", () => void removeRef(id));
    }
    await refreshUI();
    return;
  }

  renderContextDocId = id;
  try {
    content.innerHTML = await marked.parse(data.markdown);
  } finally {
    renderContextDocId = "";
  }
  rewriteRelativeMedia(content, id);
  await runMermaidSafe(content);
  wireInternalLinks(content, currentDocPath);
  status.textContent = "";

  sessionCache = await fetchSession();
  touchRepoForDocId(data.id);
  await refreshUI();

  void fetch(`/api/documents/${encodeURIComponent(id)}/discover`, { method: "POST" }).then(async (dr) => {
    if (dr.ok) {
      sessionCache = await fetchSession();
      await refreshUI();
    }
  });
}

function wireInternalLinks(el: HTMLElement, fromPath: string): void {
  el.querySelectorAll("a[href]").forEach((node) => {
    const a = node as HTMLAnchorElement;
    const href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#") || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
      return;
    }
    const low = href.split("#")[0]?.toLowerCase() ?? "";
    if (!low.endsWith(".md")) return;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void openLinkedMd(fromPath, href);
    });
  });
}

async function openLinkedMd(fromPath: string, href: string): Promise<void> {
  const r = await fetch("/api/resolve-md", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromPath, href }),
  });
  const j = (await r.json()) as { path?: string | null };
  if (!j.path) return;
  const body: { path: string; parentDocId?: string } = { path: j.path };
  if (currentDocId) body.parentDocId = currentDocId;
  const reg = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!reg.ok) return;
  const data = (await reg.json()) as { document?: { id: string } };
  const id = data.document?.id;
  if (id) await selectDoc(id);
}

function wireThemes(): void {
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset.theme as ThemeId;
      if (!id) return;
      void persistTheme(id).then(() => {
        const content = document.getElementById("content");
        if (content && content.innerHTML) {
          void runMermaidSafe(content);
        }
      });
    });
  });
}

async function boot(): Promise<void> {
  const status = document.getElementById("status");
  try {
    sessionCache = await fetchSession();
    const serverTheme = sessionCache.theme;
    if (serverTheme && (THEMES as readonly string[]).includes(serverTheme)) {
      applyTheme(serverTheme);
      localStorage.setItem(THEME_KEY, serverTheme);
    } else {
      const local = getStoredTheme();
      applyTheme(local);
      await fetch("/api/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: local }),
      });
      sessionCache = await fetchSession();
    }

    const params = new URLSearchParams(location.search);
    let docId = params.get("doc") || sessionCache.activeDocId || sessionCache.documents[0]?.id;
    if (docId) {
      await selectDoc(docId);
    } else {
      status!.textContent = "Open a .md file from the terminal: readthey file.md";
    }

    await refreshUI();

    syncSearchToggleButtons();

    document.getElementById("doc-search")?.addEventListener("input", (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      scheduleSearch();
    });

    document.getElementById("doc-search")?.addEventListener("keydown", (e) => {
      if (!e.altKey) return;
      if (e.code === "KeyC") {
        e.preventDefault();
        searchCaseSensitive = !searchCaseSensitive;
        localStorage.setItem(LS_SEARCH_CASE, searchCaseSensitive ? "1" : "0");
        syncSearchToggleButtons();
        scheduleSearch();
      }
      if (e.code === "KeyR") {
        e.preventDefault();
        searchRegex = !searchRegex;
        localStorage.setItem(LS_SEARCH_REGEX, searchRegex ? "1" : "0");
        syncSearchToggleButtons();
        scheduleSearch();
      }
    });

    document.getElementById("search-case")?.addEventListener("click", () => {
      searchCaseSensitive = !searchCaseSensitive;
      localStorage.setItem(LS_SEARCH_CASE, searchCaseSensitive ? "1" : "0");
      syncSearchToggleButtons();
      scheduleSearch();
    });

    document.getElementById("search-regex")?.addEventListener("click", () => {
      searchRegex = !searchRegex;
      localStorage.setItem(LS_SEARCH_REGEX, searchRegex ? "1" : "0");
      syncSearchToggleButtons();
      scheduleSearch();
    });

    document.getElementById("repo-typeahead")?.addEventListener("input", (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (!v) {
        selectedRepo = "all";
        void refreshUI();
        return;
      }
      const g = repoGroups(sessionCache?.documents ?? []).find((x) => x.label.toLowerCase() === v.toLowerCase());
      if (g) {
        selectedRepo = g.key;
        void refreshUI();
      }
    });

    document.getElementById("btn-discover")?.addEventListener("click", () => {
      if (!currentDocId) return;
      void fetch(`/api/documents/${encodeURIComponent(currentDocId)}/discover`, { method: "POST" }).then(async (dr) => {
        if (dr.ok) {
          sessionCache = await fetchSession();
          await refreshUI();
        }
      });
    });

    wireThemes();
    wireMermaidFullscreenDelegation();
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) return;
      const fsRoot = document.getElementById(MERMAID_FS_ID);
      if (fsRoot && !fsRoot.hidden) closeMermaidFullscreen();
    });
  } catch (e) {
    if (status) status.textContent = e instanceof Error ? e.message : "Failed to load.";
  }
}

void boot();
