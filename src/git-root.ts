import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Walk up from `startDir` (a directory) looking for `.git`. */
export function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const git = path.join(dir, ".git");
    try {
      if (existsSync(git) && (statSync(git).isDirectory() || statSync(git).isFile())) {
        return dir;
      }
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
