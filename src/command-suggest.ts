import path from "node:path";

/** Script key: docs:<stem> where stem is basename without .md */
export function scriptKeyForPath(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const safe = stem.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "doc";
  return `docs:${safe.toLowerCase()}`;
}

/** Path as it should appear in package.json script (relative to cwd, posix slashes). */
export function scriptArgRelative(cwd: string, absolutePath: string): string {
  let rel = path.relative(cwd, absolutePath);
  if (!rel || rel.startsWith("..")) {
    rel = absolutePath;
  }
  return rel.split(path.sep).join("/");
}

export function formatCommandSuggestions(cwd: string, absolutePath: string): string {
  const key = scriptKeyForPath(absolutePath);
  const arg = scriptArgRelative(cwd, absolutePath);
  const lines = [
    "",
    '\x1b[1mAdd to package.json "scripts"\x1b[0m:',
    "",
    `  "${key}": "readthey ${arg}"`,
    `  \x1b[2m(or the same line with rt instead of readthey)\x1b[0m`,
    "",
  ];
  return lines.join("\n");
}
