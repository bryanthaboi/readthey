import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extractMdLinkHrefs, linkAnchorForFile, resolveAssetHref, resolveMdHref } from "./md-discover.js";
import type { SessionDocument, SessionState, ThemeId } from "./session-store.js";
import { SessionStore } from "./session-store.js";

export const READTHEY_HOST = "127.0.0.1";
/** TCP max is 65535; 342069 is invalid — 34206 keeps the same digit run in-range. */
export const READTHEY_PORT = 34206;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

function isPathInsideRoot(resolvedFile: string, rootResolved: string): boolean {
  const rel = path.relative(rootResolved, resolvedFile);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeJoin(root: string, requestPath: string): string | null {
  const rel = requestPath.replace(/^\/+/, "");
  const base = rel === "" || rel.endsWith("/") ? path.join(root, "index.html") : path.join(root, rel);
  const resolved = path.resolve(base);
  const rootResolved = path.resolve(root);
  if (!isPathInsideRoot(resolved, rootResolved)) return null;
  return resolved;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readDocContent(absPath: string): { markdown: string; missing: boolean; mtimeMs: number | null } {
  try {
    if (!existsSync(absPath)) return { markdown: "", missing: true, mtimeMs: null };
    const st = statSync(absPath);
    if (!st.isFile()) return { markdown: "", missing: true, mtimeMs: null };
    const markdown = readFileSync(absPath, "utf8");
    return { markdown, missing: false, mtimeMs: st.mtimeMs };
  } catch {
    return { markdown: "", missing: true, mtimeMs: null };
  }
}

function docPayload(store: SessionStore, d: SessionDocument) {
  const { markdown, missing, mtimeMs } = readDocContent(d.path);
  const fresh = store.getById(d.id);
  const doc = fresh ?? d;
  return {
    id: doc.id,
    path: doc.path,
    repoRoot: doc.repoRoot,
    repoLabel: doc.repoLabel,
    title: doc.title,
    missing,
    mtimeMs,
    markdown,
  };
}

function summarizeState(state: SessionState) {
  return {
    theme: state.theme,
    activeDocId: state.activeDocId,
    documents: state.documents.map((d) => ({
      id: d.id,
      path: d.path,
      repoRoot: d.repoRoot,
      repoLabel: d.repoLabel,
      title: d.title,
      addedAt: d.addedAt,
      parentDocId: d.parentDocId ?? null,
    })),
  };
}

const THEMES: ThemeId[] = ["paper", "midnight", "sepia", "signal"];
function isTheme(t: string): t is ThemeId {
  return (THEMES as string[]).includes(t);
}

const MAX_SEARCH_QUERY_LEN = 512;
const MAX_MARKDOWN_SEARCH_BYTES = 2 * 1024 * 1024;

function buildSearchTester(
  q: string,
  regex: boolean,
  caseSensitive: boolean,
): { ok: true; test: (text: string) => boolean } | { ok: false; error: string } {
  if (regex) {
    try {
      const flags = caseSensitive ? "" : "i";
      const re = new RegExp(q, flags);
      return { ok: true, test: (text: string) => re.test(text) };
    } catch {
      return { ok: false, error: "Invalid regular expression" };
    }
  }
  if (caseSensitive) {
    return { ok: true, test: (text: string) => text.includes(q) };
  }
  const n = q.toLowerCase();
  return { ok: true, test: (text: string) => text.toLowerCase().includes(n) };
}

function runLibrarySearch(
  store: SessionStore,
  q: string,
  regex: boolean,
  caseSensitive: boolean,
): { ids: string[] } | { error: string } {
  if (q.length > MAX_SEARCH_QUERY_LEN) {
    return { error: "Query too long (max 512 characters)" };
  }
  const built = buildSearchTester(q, regex, caseSensitive);
  if (!built.ok) return { error: built.error };
  const { test } = built;
  const ids: string[] = [];
  for (const d of store.getState().documents) {
    const meta = `${d.title}\n${d.path}\n${d.repoLabel}`;
    if (test(meta)) {
      ids.push(d.id);
      continue;
    }
    const { markdown, missing } = readDocContent(d.path);
    if (missing) continue;
    const body =
      markdown.length > MAX_MARKDOWN_SEARCH_BYTES ? markdown.slice(0, MAX_MARKDOWN_SEARCH_BYTES) : markdown;
    if (test(body)) ids.push(d.id);
  }
  return { ids };
}

export function createReadtheyServer(viewerRoot: string, store: SessionStore): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${READTHEY_HOST}/`);

    if (url.pathname === "/api/health" && req.method === "GET") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      store.rescanRepos();
      store.save();
      json(res, 200, summarizeState(store.getState()));
      return;
    }

    if (url.pathname === "/api/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const regex = url.searchParams.get("regex") === "1" || url.searchParams.get("regex") === "true";
      const caseSensitive = url.searchParams.get("case") === "1" || url.searchParams.get("case") === "true";
      store.rescanRepos();
      if (!q) {
        json(res, 200, { ids: store.getState().documents.map((d) => d.id) });
        return;
      }
      const out = runLibrarySearch(store, q, regex, caseSensitive);
      if ("error" in out) {
        json(res, 400, { error: out.error });
        return;
      }
      json(res, 200, { ids: out.ids });
      return;
    }

    if (url.pathname === "/api/session" && req.method === "PATCH") {
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (body.theme !== undefined) {
          if (typeof body.theme === "string" && isTheme(body.theme)) {
            store.setTheme(body.theme);
          }
        }
        if (body.activeDocId !== undefined) {
          const id = body.activeDocId;
          if (id === null) store.setActiveDocId(null);
          else if (typeof id === "string" && store.getById(id)) store.setActiveDocId(id);
        }
        json(res, 200, summarizeState(store.getState()));
      } catch {
        json(res, 400, { error: "Invalid JSON" });
      }
      return;
    }

    if (url.pathname === "/api/documents" && req.method === "POST") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { path?: string; parentDocId?: string | null };
        if (!body.path || typeof body.path !== "string") {
          json(res, 400, { error: "Missing path" });
          return;
        }
        const abs = path.resolve(body.path);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        if (!abs.toLowerCase().endsWith(".md")) {
          json(res, 400, { error: "Not a Markdown file" });
          return;
        }
        const preview = readFileSync(abs, "utf8").slice(0, 8000);
        const parentOpt =
          body.parentDocId === null || body.parentDocId === undefined
            ? undefined
            : typeof body.parentDocId === "string"
              ? body.parentDocId
              : undefined;
        const doc = store.addDocument(abs, preview, { parentDocId: parentOpt });
        store.rescanRepos();
        store.save();
        json(res, 200, {
          session: summarizeState(store.getState()),
          document: docPayload(store, doc),
        });
      } catch {
        json(res, 400, { error: "Invalid request" });
      }
      return;
    }

    const delMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (delMatch && req.method === "DELETE") {
      const id = delMatch[1];
      if (!store.remove(id)) {
        json(res, 404, { error: "Unknown document" });
        return;
      }
      json(res, 200, summarizeState(store.getState()));
      return;
    }

    const getMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/content$/);
    if (getMatch && req.method === "GET") {
      const id = getMatch[1];
      const d = store.getById(id);
      if (!d) {
        json(res, 404, { error: "Unknown document" });
        return;
      }
      store.rescanRepos();
      json(res, 200, docPayload(store, d));
      return;
    }

    const assetMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/asset$/);
    if (assetMatch && req.method === "GET") {
      const id = assetMatch[1];
      const d = store.getById(id);
      if (!d) {
        res.writeHead(404).end("Not found");
        return;
      }
      const pathParam = url.searchParams.get("path");
      if (!pathParam) {
        res.writeHead(400).end("Missing path");
        return;
      }
      store.rescanRepos();
      const resolved = resolveAssetHref(d.path, d.repoRoot, pathParam);
      if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
        res.writeHead(404).end("Not found");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      fs.createReadStream(resolved)
        .on("error", () => {
          if (!res.writableEnded) res.destroy();
        })
        .pipe(res);
      return;
    }

    const discMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/discover$/);
    if (discMatch && req.method === "POST") {
      const id = discMatch[1];
      const d = store.getById(id);
      if (!d) {
        json(res, 404, { error: "Unknown document" });
        return;
      }
      const { markdown, missing } = readDocContent(d.path);
      if (missing) {
        json(res, 200, { added: [], session: summarizeState(store.getState()) });
        return;
      }
      const anchor = linkAnchorForFile(d.path, d.repoRoot);
      const hrefs = extractMdLinkHrefs(markdown);
      const added: SessionDocument[] = [];
      for (const h of hrefs) {
        const target = resolveMdHref(d.path, h);
        const rel = path.relative(path.resolve(anchor), path.resolve(target));
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
        if (!existsSync(target) || !statSync(target).isFile()) continue;
        if (!target.toLowerCase().endsWith(".md")) continue;
        if (store.findByPath(target)) continue;
        const preview = readFileSync(target, "utf8").slice(0, 8000);
        added.push(store.addDocument(target, preview, { activate: false, parentDocId: id }));
      }
      store.rescanRepos();
      store.save();
      json(res, 200, { added: added.map((x) => ({ id: x.id, path: x.path, title: x.title, repoLabel: x.repoLabel })), session: summarizeState(store.getState()) });
      return;
    }

    if (url.pathname === "/api/resolve-md" && req.method === "POST") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { fromPath?: string; href?: string };
        if (!body.fromPath || !body.href || typeof body.fromPath !== "string" || typeof body.href !== "string") {
          json(res, 400, { error: "fromPath and href required" });
          return;
        }
        const fromAbs = path.resolve(body.fromPath);
        const d = store.findByPath(fromAbs);
        if (!d) {
          json(res, 404, { error: "Unknown source document" });
          return;
        }
        const hrefPath = body.href.trim().split("#")[0] ?? "";
        if (!hrefPath.toLowerCase().endsWith(".md")) {
          json(res, 200, { path: null });
          return;
        }
        const target = resolveMdHref(fromAbs, hrefPath);
        const anchor = linkAnchorForFile(fromAbs, d.repoRoot);
        const rel = path.relative(path.resolve(anchor), path.resolve(target));
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          json(res, 200, { path: null });
          return;
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          json(res, 200, { path: null });
          return;
        }
        json(res, 200, { path: target });
      } catch {
        json(res, 400, { error: "Invalid request" });
      }
      return;
    }

    if (url.pathname === "/api/markdown" && req.method === "GET") {
      json(res, 410, { error: "Use /api/documents/:id/content" });
      return;
    }

    let filePath = safeJoin(viewerRoot, url.pathname);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      if (url.pathname === "/" || url.pathname === "") {
        filePath = path.join(viewerRoot, "index.html");
      }
    }
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(filePath)
      .on("error", () => {
        if (!res.writableEnded) res.destroy();
      })
      .pipe(res);
  });

  return server;
}

export function listenReadthey(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(READTHEY_PORT, READTHEY_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function readtheyOrigin(): string {
  return `http://${READTHEY_HOST}:${READTHEY_PORT}`;
}
