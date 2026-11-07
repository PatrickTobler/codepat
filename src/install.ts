import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = join(home, ".config/codepat");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
const envPath = join(configDir, "environment");
if (!existsSync(envPath))
  writeFileSync(
    envPath,
    readFileSync(join(appDir, "deploy/environment.example")),
    { mode: 0o600 },
  );
const path = `${dirname(process.execPath)}:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
const herdrSocket = join(home, ".config/herdr/herdr.sock");
if (process.platform === "darwin") installLaunchAgent();
else installSystemdUnit();

function installLaunchAgent(): void {
  const label = "com.codepat.bridge";
  const agentDir = join(home, "Library/LaunchAgents");
  const logDir = join(home, "Library/Logs/codepat");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const xml = (value: string) => `<string>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
  // sh sources the environment file with paths passed as arguments, so spaces in paths stay safe.
  const program = ["/bin/sh", "-c", 'set -a; . "$1"; set +a; exec "$2" src/main.ts', "codepat", envPath, process.execPath];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${xml(label)}
<key>ProgramArguments</key><array>${program.map(xml).join("")}</array>
<key>WorkingDirectory</key>${xml(appDir)}
<key>EnvironmentVariables</key><dict>
<key>HOME</key>${xml(home)}
<key>PATH</key>${xml(path)}
<key>HERDR_ENV</key>${xml("1")}
<key>HERDR_SOCKET_PATH</key>${xml(herdrSocket)}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${xml(join(logDir, "bridge.log"))}
<key>StandardErrorPath</key>${xml(join(logDir, "bridge.log"))}
</dict></plist>
`;
  const plistPath = join(agentDir, `${label}.plist`);
  writeFileSync(plistPath, plist, { mode: 0o644 });
  const domain = `gui/${process.getuid!()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  // bootout returns before launchd has unloaded the job; bootstrap fails with EIO until it has.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "pipe" });
      break;
    } catch (error) {
      if (attempt === 10) throw error;
      execFileSync("sleep", ["1"]);
    }
  }
  console.log(`CodePat launch agent installed (${plistPath}); logs in ${logDir}.`);
}

function installSystemdUnit(): void {
  const unitDir = join(home, ".config/systemd/user");
  mkdirSync(unitDir, { recursive: true });
  // These values are systemd syntax, not shell text. Reject newline/quote injection.
  for (const value of [home, appDir, process.execPath])
    if (/[\s"%]/.test(value)) throw new Error("Unsupported systemd path");
  const quote = (value: string) => `"${value}"`;
  const unit = `[Unit]\nDescription=CodePat Herdr orchestrator bridge\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${appDir}\nExecStart=${quote(process.execPath)} src/main.ts\nEnvironment=${quote(`HOME=${home}`)}\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=HERDR_ENV=1\nEnvironment=${quote(`HERDR_SOCKET_PATH=${herdrSocket}`)}\nEnvironmentFile=-${envPath}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(join(unitDir, "codepat.service"), unit, { mode: 0o644 });
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus`,
  };
  execFileSync("systemctl", ["--user", "daemon-reload"], { env, stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", "codepat.service"], { env, stdio: "inherit" });
  console.log(
    "CodePat user service installed. Enable user lingering for startup without an SSH login: sudo loginctl enable-linger " +
      process.env.USER,
  );
}
