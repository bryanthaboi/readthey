import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function asciilogoPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "asciilogo.md"),
    path.join(here, "..", "asciilogo.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

export function loadAsciilogo(): string {
  try {
    return readFileSync(asciilogoPath(), "utf8").trimEnd();
  } catch {
    return "readthey";
  }
}

export function formatHelp(asciilogo: string): string {
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const lines = [
    asciilogo,
    "",
    `${bold}readthey${reset} ${dim}—${reset} read Markdown in the browser (Mermaid, themes, persistent library).`,
    `${dim}Port 127.0.0.1:34206 · by bryanthaboi${reset}`,
    "",
    `${bold}Usage${reset}`,
    `  readthey                 ${dim}README or pick a .md; starts server if needed${reset}`,
    `  readthey <file.md>       ${dim}add/open that file (refresh = latest from disk)${reset}`,
    `  readthey server          ${dim}run the background server only${reset}`,
    `  readthey stop            ${dim}stop the server (session file kept)${reset}`,
    `  readthey boot            ${dim}auto-start server at login (Mac / Windows / Linux)${reset}`,
    `  readthey boot --off      ${dim}remove that auto-start${reset}`,
    `  readthey --boot          ${dim}same as readthey boot${reset}`,
    `  readthey --boot-off      ${dim}same as readthey boot --off${reset}`,
    `  readthey --command <path> ${dim}suggested package.json scripts${reset}`,
    `  readthey --help          ${dim}this screen${reset}`,
    "",
    `${bold}Session${reset}  ${dim}~/.readthey/state.json · override dir: READTHEY_HOME${reset}`,
    "",
    `${bold}Aliases${reset}  ${dim}rt … (same commands)${reset}`,
    "",
  ];
  return lines.join("\n");
}
