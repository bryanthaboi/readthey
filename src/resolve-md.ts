import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.MD",
  "ReadMe.md",
];

export function findReadmeInDir(dir: string): string | null {
  for (const name of README_NAMES) {
    const full = path.join(dir, name);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

function isReadmeBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower === "readme.md" || lower.startsWith("readme.");
}

export function listMarkdownInDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const md = names.filter((n) => n.toLowerCase().endsWith(".md"));
  const full = md
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  full.sort((a, b) => {
    const ba = path.basename(a);
    const bb = path.basename(b);
    const ra = isReadmeBasename(ba);
    const rb = isReadmeBasename(bb);
    if (ra !== rb) return ra ? -1 : 1;
    return ba.localeCompare(bb, undefined, { sensitivity: "base" });
  });
  return full;
}

export function resolveMarkdownPath(cwd: string, userPath: string): string {
  const abs = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.resolve(cwd, userPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`Not a file: ${userPath}`);
  }
  if (!abs.toLowerCase().endsWith(".md")) {
    throw new Error(`Not a Markdown file: ${userPath}`);
  }
  return abs;
}
