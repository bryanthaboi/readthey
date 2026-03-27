import path from "node:path";

/** Markdown [text](href) where href is relative .md (optional #anchor). */
const MD_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function stripHash(href: string): string {
  const hash = href.indexOf("#");
  return hash >= 0 ? href.slice(0, hash) : href;
}

export function extractMdLinkHrefs(markdown: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(markdown)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("mailto:")) {
      continue;
    }
    const pathPart = stripHash(raw).trim();
    if (!pathPart.toLowerCase().endsWith(".md")) continue;
    out.push(pathPart);
  }
  return out;
}

/**
 * Directory tree allowed for relative links and assets: git root when the file
 * lies inside it; otherwise parent of the file's folder (same as no-git mode).
 * If `repoRoot` is stale or wrong, falling back avoids false "outside repo" rejects.
 */
export function linkAnchorForFile(absFile: string, repoRoot: string | null): string {
  const fileDir = path.dirname(path.resolve(absFile));
  if (repoRoot) {
    const rr = path.resolve(repoRoot);
    if (fileDir === rr || fileDir.startsWith(rr + path.sep)) {
      return rr;
    }
  }
  return path.resolve(fileDir, "..");
}

export function resolveMdHref(fromFile: string, href: string): string {
  const dir = path.dirname(path.resolve(fromFile));
  return path.resolve(dir, href);
}

/**
 * Resolve an image (or other static asset) href relative to the markdown file.
 * Returns null for http(s)/data URLs or paths outside the same anchor as markdown links.
 */
export function resolveAssetHref(fromFile: string, repoRoot: string | null, href: string): string | null {
  const raw = href.trim().split("#")[0]?.trim() ?? "";
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("data:")) {
    return null;
  }
  const fileDir = path.dirname(path.resolve(fromFile));
  const rr = repoRoot ? path.resolve(repoRoot) : null;
  let resolved: string;
  if (raw.startsWith("/")) {
    const rest = raw.replace(/^\/+/, "");
    if (rr) {
      resolved = path.resolve(rr, rest);
    } else {
      resolved = path.resolve(fileDir, rest);
    }
  } else {
    resolved = path.resolve(fileDir, raw);
  }
  const anchor = path.resolve(linkAnchorForFile(fromFile, repoRoot));
  const rel = path.relative(anchor, path.resolve(resolved));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.resolve(resolved);
}
