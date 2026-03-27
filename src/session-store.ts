import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readtheyDir, statePath } from "./readthey-home.js";
import { findGitRoot } from "./git-root.js";

export type ThemeId = "paper" | "midnight" | "sepia" | "signal";

export interface SessionDocument {
  id: string;
  path: string;
  repoRoot: string | null;
  /** Display: basename(repoRoot) or "library" */
  repoLabel: string;
  title: string;
  addedAt: string;
  /** When set, this doc was linked from or discovered under the parent; preserved on re-add. */
  parentDocId: string | null;
}

export interface SessionState {
  v: 1;
  theme: ThemeId;
  activeDocId: string | null;
  documents: SessionDocument[];
}

const DEFAULT_STATE: SessionState = {
  v: 1,
  theme: "paper",
  activeDocId: null,
  documents: [],
};

const THEMES: ThemeId[] = ["paper", "midnight", "sepia", "signal"];

function isTheme(t: string): t is ThemeId {
  return (THEMES as string[]).includes(t);
}

function titleFromMarkdown(content: string, fallback: string): string {
  const line = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const m = line.match(/^#{1,6}\s+(.+)/);
  if (m) return m[1].trim().slice(0, 120);
  return fallback;
}

function repoLabelFor(repoRoot: string | null): string {
  if (!repoRoot) return "library";
  return path.basename(repoRoot) || "library";
}

export class SessionStore {
  private state: SessionState;

  constructor() {
    mkdirSync(readtheyDir(), { recursive: true });
    this.state = this.load();
  }

  private load(): SessionState {
    const p = statePath();
    if (!existsSync(p)) return { ...DEFAULT_STATE, documents: [] };
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SessionState>;
      if (raw.v !== 1 || !Array.isArray(raw.documents)) return { ...DEFAULT_STATE, documents: [] };
      const theme = raw.theme && isTheme(raw.theme) ? raw.theme : "paper";
      return {
        v: 1,
        theme,
        activeDocId: typeof raw.activeDocId === "string" ? raw.activeDocId : null,
        documents: raw.documents
          .filter((d) => d && typeof d.id === "string" && typeof d.path === "string")
          .map((d) => ({
            id: d.id,
            path: path.resolve(d.path),
            repoRoot: d.repoRoot ? path.resolve(d.repoRoot) : null,
            repoLabel: typeof d.repoLabel === "string" ? d.repoLabel : repoLabelFor(d.repoRoot ? path.resolve(d.repoRoot) : null),
            title: typeof d.title === "string" ? d.title : path.basename(d.path),
            addedAt: typeof d.addedAt === "string" ? d.addedAt : new Date().toISOString(),
            parentDocId: typeof d.parentDocId === "string" ? d.parentDocId : null,
          })),
      };
    } catch {
      return { ...DEFAULT_STATE, documents: [] };
    }
  }

  save(): void {
    const p = statePath();
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, p);
  }

  getState(): SessionState {
    return {
      ...this.state,
      documents: this.state.documents.map((d) => ({ ...d })),
    };
  }

  /** Recompute git roots and labels from current paths. */
  rescanRepos(): void {
    for (const d of this.state.documents) {
      const dir = path.dirname(d.path);
      const rr = findGitRoot(dir);
      d.repoRoot = rr;
      d.repoLabel = repoLabelFor(rr);
    }
  }

  setTheme(theme: ThemeId): void {
    this.state.theme = theme;
    this.save();
  }

  setActiveDocId(id: string | null): void {
    this.state.activeDocId = id;
    this.save();
  }

  findByPath(absPath: string): SessionDocument | undefined {
    const resolved = path.resolve(absPath);
    return this.state.documents.find((d) => d.path === resolved);
  }

  getById(id: string): SessionDocument | undefined {
    return this.state.documents.find((d) => d.id === id);
  }

  remove(id: string): boolean {
    const i = this.state.documents.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const removed = this.state.documents[i]!;
    const grandParent = removed.parentDocId;
    for (const d of this.state.documents) {
      if (d.parentDocId === id) d.parentDocId = grandParent;
    }
    this.state.documents.splice(i, 1);
    if (this.state.activeDocId === id) {
      this.state.activeDocId = this.state.documents[0]?.id ?? null;
    }
    this.save();
    return true;
  }

  addDocument(
    absPath: string,
    markdownPreview?: string,
    opts?: { activate?: boolean; parentDocId?: string | null },
  ): SessionDocument {
    const activate = opts?.activate !== false;
    const resolved = path.resolve(absPath);
    const existing = this.findByPath(resolved);
    if (existing) {
      this.rescanRepos();
      existing.repoRoot = findGitRoot(path.dirname(resolved));
      existing.repoLabel = repoLabelFor(existing.repoRoot);
      if (activate) this.state.activeDocId = existing.id;
      this.save();
      return existing;
    }
    const dir = path.dirname(resolved);
    const repoRoot = findGitRoot(dir);
    const base = path.basename(resolved);
    const title = markdownPreview ? titleFromMarkdown(markdownPreview, base) : base;
    let parentDocId: string | null = null;
    const wantParent = opts?.parentDocId;
    if (typeof wantParent === "string" && this.getById(wantParent)) {
      parentDocId = wantParent;
    }
    const doc: SessionDocument = {
      id: randomUUID(),
      path: resolved,
      repoRoot,
      repoLabel: repoLabelFor(repoRoot),
      title,
      addedAt: new Date().toISOString(),
      parentDocId,
    };
    this.state.documents.push(doc);
    if (activate) this.state.activeDocId = doc.id;
    this.save();
    return doc;
  }

}
