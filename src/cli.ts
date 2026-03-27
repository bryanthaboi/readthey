#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import open from "open";
import { formatCommandSuggestions } from "./command-suggest.js";
import { formatHelp, loadAsciilogo } from "./help.js";
import { pidPath } from "./readthey-home.js";
import { SessionStore } from "./session-store.js";
import {
  findReadmeInDir,
  listMarkdownInDir,
  resolveMarkdownPath,
} from "./resolve-md.js";
import {
  createReadtheyServer,
  listenReadthey,
  readtheyOrigin,
  READTHEY_HOST,
  READTHEY_PORT,
} from "./server.js";
import { configureBootService } from "./boot-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);

function viewerRoot(): string {
  return path.join(__dirname, "viewer");
}

async function ping(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${readtheyOrigin()}/api/health`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(totalMs = 12000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function ensureServerRunning(): Promise<void> {
  if (await ping()) return;
  const child = spawn(process.execPath, [ENTRY, "server"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const ok = await waitForHealth();
  if (!ok) {
    console.error(
      "\x1b[31mCould not start readthey server.\x1b[0m\n" +
        `Check port ${READTHEY_PORT} on ${READTHEY_HOST} or run \x1b[1mreadthey stop\x1b[0m and try again.`,
    );
    process.exit(1);
  }
}

async function registerDocumentAndOpen(absPath: string): Promise<void> {
  await ensureServerRunning();
  const origin = readtheyOrigin();
  const res = await fetch(`${origin}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absPath }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`\x1b[31m${err.error ?? res.statusText}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as { document?: { id: string } };
  const id = data.document?.id;
  if (!id) {
    console.error("\x1b[31mUnexpected server response\x1b[0m");
    process.exitCode = 1;
    return;
  }
  const url = `${origin}/?doc=${encodeURIComponent(id)}`;
  console.log(`\x1b[2m${url}\x1b[0m`);
  await open(url);
}

async function runDaemon(): Promise<void> {
  const store = new SessionStore();
  const server = createReadtheyServer(viewerRoot(), store);
  try {
    await listenReadthey(server);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(
        `\x1b[31mPort ${READTHEY_PORT} is in use on ${READTHEY_HOST}.\x1b[0m\n` +
          `Server may already be running. Open the app or run \x1b[1mreadthey stop\x1b[0m.`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  writeFileSync(pidPath(), String(process.pid), "utf8");
  console.log(`readthey server · ${readtheyOrigin()}`);
  console.log(`\x1b[2mPID ${process.pid} · readthey stop to shut down\x1b[0m`);

  const shutdown = () => {
    try {
      unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function stopDaemon(): void {
  const p = pidPath();
  if (!existsSync(p)) {
    console.log("\x1b[2mNo readthey server pid file (server may not be running).\x1b[0m");
    return;
  }
  const raw = readFileSync(p, "utf8").trim();
  const pid = parseInt(raw, 10);
  if (Number.isNaN(pid)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`\x1b[2mSent SIGTERM to readthey server (PID ${pid}).\x1b[0m`);
  } catch {
    console.log("\x1b[2mProcess not found; removing stale pid file.\x1b[0m");
  }
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

async function promptChoice(pageLen: number, hasMore: boolean): Promise<number | "more" | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = hasMore ? `1–${pageLen} or 11 for more` : `1–${pageLen}`;
  const answer = await new Promise<string>((resolve) => {
    rl.question(`\x1b[2m${hint}\x1b[0m: `, resolve);
  });
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (hasMore && (trimmed === "more" || trimmed === "11")) return "more";
  const n = parseInt(trimmed, 10);
  if (hasMore && n === 11) return "more";
  if (!Number.isNaN(n) && n >= 1 && n <= pageLen) return n;
  return null;
}

async function pickMarkdownInteractive(cwd: string): Promise<string> {
  const all = listMarkdownInDir(cwd);
  if (all.length === 0) {
    console.error("\x1b[31mNo .md files in this directory.\x1b[0m");
    process.exit(1);
  }
  let offset = 0;
  for (;;) {
    const page = all.slice(offset, offset + 10);
    const hasMore = offset + page.length < all.length;
    console.log("");
    page.forEach((f, i) => {
      console.log(`  \x1b[1m${i + 1}.\x1b[0m ${path.relative(cwd, f) || f}`);
    });
    if (hasMore) console.log(`  \x1b[1m11.\x1b[0m more`);
    const choice = await promptChoice(page.length, hasMore);
    if (choice === "more") {
      offset += 10;
      continue;
    }
    if (choice === null) {
      console.log("\x1b[2mInvalid choice — try again.\x1b[0m");
      continue;
    }
    return page[choice - 1];
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const argv0 = process.argv[1] ? path.basename(process.argv[1]) : "readthey";
  const prog = argv0 === "rt" || argv0.startsWith("rt.") ? "rt" : "readthey";

  const cli = cac(prog);
  cli.option("-c, --command <path>", "Print suggested package.json scripts for a .md file");
  cli.option("--boot", "Install login auto-start for readthey server (same as: readthey boot)");
  cli.option("--boot-off", "Remove login auto-start");
  cli.help(() => {
    console.log(formatHelp(loadAsciilogo()));
    return [];
  });

  cli.parse(process.argv, { run: false });

  if (cli.options.help) return;

  const args = cli.args as string[];

  if (cli.options.bootOff) {
    configureBootService(true);
    return;
  }
  if (cli.options.boot) {
    if (args.length > 0) {
      console.error("\x1b[31m--boot cannot be combined with a file path. Use readthey boot.\x1b[0m");
      process.exitCode = 1;
      return;
    }
    configureBootService(false);
    return;
  }

  if (args[0] === "boot") {
    // cac strips unknown flags from cli.args; --off is not a global option.
    const wantOff = process.argv.includes("--off");
    const extra = args.slice(1);
    if (extra.length > 0) {
      console.error("\x1b[31mreadthey boot only accepts optional --off\x1b[0m");
      process.exitCode = 1;
      return;
    }
    configureBootService(wantOff);
    return;
  }

  if (args[0] === "server") {
    if (args.length > 1) {
      console.error("\x1b[31mreadthey server takes no arguments\x1b[0m");
      process.exitCode = 1;
      return;
    }
    await runDaemon();
    return;
  }

  if (args[0] === "stop") {
    if (args.length > 1) {
      console.error("\x1b[31mreadthey stop takes no arguments\x1b[0m");
      process.exitCode = 1;
      return;
    }
    stopDaemon();
    return;
  }

  if (cli.options.command !== undefined) {
    const commandPath = cli.options.command as string;
    if (!commandPath || String(commandPath).trim() === "") {
      console.error("\x1b[31m--command requires a path, e.g. --command readme.md\x1b[0m");
      process.exitCode = 1;
      return;
    }
    const abs = resolveMarkdownPath(cwd, commandPath);
    console.log(formatCommandSuggestions(cwd, abs));
    return;
  }

  let target: string;
  if (args.length === 0) {
    const readme = findReadmeInDir(cwd);
    if (readme) {
      target = readme;
    } else {
      target = await pickMarkdownInteractive(cwd);
    }
  } else {
    target = resolveMarkdownPath(cwd, String(args[0]));
  }

  await registerDocumentAndOpen(target);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
