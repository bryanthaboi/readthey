import { execFileSync } from "node:child_process";
import open from "open";

/** Full button text override (e.g. `Open in Obsidian`). */
const ENV_BUTTON = "READTHEY_OPEN_BUTTON";
/** Short editor name; button becomes `Open in {name}`. */
const ENV_LABEL = "READTHEY_OPEN_LABEL";

const LINUX_DESKTOP: Record<string, string> = {
  code: "VS Code",
  "code-url-handler": "VS Code",
  cursor: "Cursor",
  "cursor-url-handler": "Cursor",
  codium: "VSCodium",
  "vscodium-url-handler": "VSCodium",
  typora: "Typora",
  obsidian: "Obsidian",
  sublime_text: "Sublime Text",
  sublime_text_3: "Sublime Text",
  zed: "Zed",
  "com.visualstudio.code": "VS Code",
  "com.visualstudio.code.url-handler": "VS Code",
};

function humanizeKey(key: string): string {
  return key
    .split(/[-._]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function linuxDesktopToName(desktop: string): string | null {
  const key = desktop.replace(/\.desktop$/i, "").toLowerCase();
  if (LINUX_DESKTOP[key]) return LINUX_DESKTOP[key]!;
  if (key.includes("cursor")) return "Cursor";
  if (key.includes("vscode") || key === "code" || key.endsWith(".code")) return "VS Code";
  return humanizeKey(key);
}

function linuxGuessName(): string | null {
  try {
    for (const mime of ["text/markdown", "text/x-markdown", "text/plain"]) {
      const desktop = execFileSync("xdg-mime", ["query", "default", mime], {
        encoding: "utf8",
        timeout: 2500,
      }).trim();
      if (desktop) return linuxDesktopToName(desktop);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function win32GuessName(): string | null {
  try {
    const assocOut = execFileSync("cmd.exe", ["/c", "assoc", ".md"], {
      encoding: "utf8",
      timeout: 4000,
    }).trim();
    const am = assocOut.match(/\.md=(.+)$/i);
    if (!am) return null;
    const progId = am[1]!.trim();
    const ftypeOut = execFileSync("cmd.exe", ["/c", "ftype", progId], {
      encoding: "utf8",
      timeout: 4000,
    }).trim();
    const low = ftypeOut.toLowerCase();
    if (/\bcursor\.exe\b/i.test(ftypeOut) || low.includes("cursor\\")) return "Cursor";
    if (/\bcode\.exe\b/i.test(ftypeOut)) return "VS Code";
    if (low.includes("notepad++.exe")) return "Notepad++";
    if (low.includes("notepad.exe")) return "Notepad";
    if (low.includes("sublime_text")) return "Sublime Text";
    if (low.includes("obsidian")) return "Obsidian";
    if (low.includes("typora")) return "Typora";
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Human-readable editor hint for the "open externally" button.
 * OS default open always uses the real handler; this is label-only.
 */
export function getOpenExternalButtonText(): string {
  const full = process.env[ENV_BUTTON]?.trim();
  if (full) return full;

  const short = process.env[ENV_LABEL]?.trim();
  if (short) return `Open in ${short}`;

  if (process.platform === "linux") {
    const n = linuxGuessName();
    if (n) return `Open in ${n}`;
  }
  if (process.platform === "win32") {
    const n = win32GuessName();
    if (n) return `Open in ${n}`;
  }

  return "Open in editor";
}

export async function openPathWithSystemDefault(absPath: string): Promise<void> {
  await open(absPath);
}
