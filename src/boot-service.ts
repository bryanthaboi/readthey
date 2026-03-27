import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const LAUNCH_AGENT_LABEL = "com.readthey.server";
const SYSTEMD_SERVICE = "readthey.service";
const WIN_TASK_NAME = "readthey-server";
const DESKTOP_NAME = "readthey-server.desktop";

function cliExecutable(): string {
  const p = process.argv[1];
  if (!p) {
    throw new Error("Could not resolve the readthey program path. Run readthey from its global install.");
  }
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function ok(s: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${s}`);
}

function macPlist(execPath: string): string {
  const home = homedir();
  const logOut = path.join(home, ".readthey", "server.log");
  const logErr = path.join(home, ".readthey", "server.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logErr)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function systemdUserUnit(execPath: string): string {
  return `[Unit]
Description=readthey Markdown server
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuoteExec(execPath)} server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function systemdQuoteExec(p: string): string {
  if (!/[\\s"']/.test(p)) return p;
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function xdgDesktop(execPath: string): string {
  const q = execPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[Desktop Entry]
Type=Application
Name=readthey server
Exec="${q}" server
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function hasSystemctlUser(): boolean {
  const w = spawnSync("which", ["systemctl"], { stdio: ["ignore", "ignore", "ignore"] });
  if (w.status !== 0) return false;
  const r = spawnSync("systemctl", ["--user", "show-environment"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
  });
  return !r.error && r.status === 0;
}

export function configureBootService(remove: boolean): void {
  const platform = process.platform;
  if (platform === "darwin") {
    configureMac(remove);
    return;
  }
  if (platform === "win32") {
    configureWindows(remove);
    return;
  }
  if (platform === "linux") {
    configureLinux(remove);
    return;
  }
  console.error(`\x1b[31mreadthey boot is not wired for ${platform} yet.\x1b[0m`);
  console.error(dim("Use readthey server in your OS scheduler, or open an issue with your OS name."));
  process.exitCode = 1;
}

function configureMac(remove: boolean): void {
  const agentsDir = path.join(homedir(), "Library/LaunchAgents");
  const plistPath = path.join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`);

  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }

  if (remove) {
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
      ok("Removed login auto-start (LaunchAgent).");
    } else {
      console.log(dim("No LaunchAgent was installed."));
    }
    return;
  }

  mkdirSync(path.join(homedir(), ".readthey"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const execPath = cliExecutable();
  writeFileSync(plistPath, macPlist(execPath), "utf8");
  chmodSync(plistPath, 0o644);

  try {
    execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
  } catch {
    try {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
      } else {
        throw new Error("launchctl load failed");
      }
    } catch {
      console.error("\x1b[31mCould not load LaunchAgent. Try: launchctl load ~/Library/LaunchAgents/com.readthey.server.plist\x1b[0m");
      process.exitCode = 1;
      return;
    }
  }

  ok("readthey will start at login (macOS LaunchAgent).");
  console.log(dim(`Logs: ~/.readthey/server.log`));
  console.log(dim("Turn off: readthey boot --off"));
}

function configureLinux(remove: boolean): void {
  const unitDir = path.join(homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, SYSTEMD_SERVICE);
  const execPath = cliExecutable();

  if (hasSystemctlUser()) {
    if (remove) {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
      if (existsSync(unitPath)) {
        unlinkSync(unitPath);
        try {
          execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        } catch {
          /* ignore */
        }
        ok("Removed systemd user service.");
      } else {
        removeXdgAutostart();
      }
      return;
    }

    mkdirSync(unitDir, { recursive: true });
    mkdirSync(path.join(homedir(), ".readthey"), { recursive: true });
    writeFileSync(unitPath, systemdUserUnit(execPath), "utf8");
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_SERVICE], { stdio: "inherit" });
    ok("readthey will start when your user session is active (systemd --user).");
    console.log(dim("Before graphical login on some setups: sudo loginctl enable-linger $USER"));
    console.log(dim("Turn off: readthey boot --off"));
    return;
  }

  if (remove) {
    removeXdgAutostart();
    return;
  }

  const autostartDir = path.join(homedir(), ".config", "autostart");
  mkdirSync(autostartDir, { recursive: true });
  mkdirSync(path.join(homedir(), ".readthey"), { recursive: true });
  const desktopPath = path.join(autostartDir, DESKTOP_NAME);
  writeFileSync(desktopPath, xdgDesktop(execPath), "utf8");
  chmodSync(desktopPath, 0o644);
  ok("readthey will start when you log in to the desktop (XDG autostart).");
  console.log(dim("Turn off: readthey boot --off"));
}

function removeXdgAutostart(): void {
  const desktopPath = path.join(homedir(), ".config", "autostart", DESKTOP_NAME);
  if (existsSync(desktopPath)) {
    unlinkSync(desktopPath);
    ok("Removed XDG autostart entry.");
  } else {
    console.log(dim("No autostart entry was installed."));
  }
}

function configureWindows(remove: boolean): void {
  const execPath = cliExecutable();
  const taskName = WIN_TASK_NAME;

  if (remove) {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "inherit" });
      ok("Removed scheduled task.");
    } catch {
      console.log(dim("Task was not installed or could not be removed."));
    }
    return;
  }

  const isCmd = execPath.toLowerCase().endsWith(".cmd");
  const tr = isCmd ? `cmd.exe /c "${execPath}" server` : `"${execPath}" server`;

  try {
    execFileSync(
      "schtasks",
      ["/Create", "/F", "/TN", taskName, "/TR", tr, "/SC", "ONLOGON"],
      { stdio: "inherit" },
    );
    ok("readthey will start when you sign in to Windows (Task Scheduler).");
    console.log(dim("Turn off: readthey boot --off"));
  } catch {
    console.error(
      "\x1b[31mCould not create the task. Open Task Scheduler, create a task “At log on”,\x1b[0m\n" +
        dim(`program: cmd.exe  arguments: /c "${execPath}" server`),
    );
    process.exitCode = 1;
  }
}
