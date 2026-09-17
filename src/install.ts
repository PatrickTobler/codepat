import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = join(home, ".config/codepat");
const unitDir = join(home, ".config/systemd/user");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(unitDir, { recursive: true });
const envPath = join(configDir, "environment");
if (!existsSync(envPath))
  writeFileSync(
    envPath,
    readFileSync(join(appDir, "deploy/environment.example")),
    { mode: 0o600 },
  );
// These values are systemd syntax, not shell text. Reject newline/quote injection.
for (const path of [home, appDir, process.execPath])
  if (/[\s"%]/.test(path)) throw new Error("Unsupported systemd path");
const quote = (value: string) => `"${value}"`;
const unit = `[Unit]\nDescription=CodePat Herdr orchestrator bridge\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${appDir}\nExecStart=${quote(process.execPath)} src/main.ts\nEnvironment=${quote(`HOME=${home}`)}\nEnvironment=${quote(`PATH=${dirname(process.execPath)}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)}\nEnvironment=HERDR_ENV=1\nEnvironment=${quote(`HERDR_SOCKET_PATH=${home}/.config/herdr/herdr.sock`)}\nEnvironmentFile=-${envPath}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
writeFileSync(join(unitDir, "codepat.service"), unit, { mode: 0o644 });
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus`,
};
execFileSync("systemctl", ["--user", "daemon-reload"], {
  env,
  stdio: "inherit",
});
execFileSync("systemctl", ["--user", "enable", "--now", "codepat.service"], {
  env,
  stdio: "inherit",
});
console.log(
  "CodePat user service installed. Enable user lingering for startup without an SSH login: sudo loginctl enable-linger " +
    process.env.USER,
);
