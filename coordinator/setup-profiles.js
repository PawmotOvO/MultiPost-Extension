#!/usr/bin/env node
/**
 * MultiPost Multi-Profile Setup Script
 *
 * Creates N isolated Chrome user-data directories and a launcher script so
 * users can run multiple Chrome profiles (each logged into a different
 * platform account) with a single command.
 *
 * Usage:
 *   node setup-profiles.js --accounts 3 [--extension /path/to/build/chrome-mv3-dev]
 *
 * Output:
 *   ~/.multipost-profiles/
 *     profile-1/   (Chrome user-data-dir)
 *     profile-2/
 *     profile-3/
 *     start-all.sh (or start-all.bat on Windows)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const args = { accounts: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--accounts" && argv[i + 1]) {
      args.accounts = Number.parseInt(argv[i + 1], 10) || 2;
      i++;
    } else if (argv[i] === "--extension" && argv[i + 1]) {
      args.extension = argv[i + 1];
      i++;
    }
  }
  return args;
}

function detectChrome() {
  const platform = os.platform();
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  };
  const list = candidates[platform] || [];
  for (const c of list) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: let the OS resolve it
  return platform === "win32" ? "chrome.exe" : "google-chrome";
}

function resolveExtensionPath(given) {
  if (given) return path.resolve(given);
  // Try the default build output relative to repo root
  const repoRoot = path.resolve(__dirname, "..");
  const dev = path.join(repoRoot, "build", "chrome-mv3-dev");
  if (fs.existsSync(dev)) return dev;
  return dev; // return anyway, user will see the path in the script
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = os.homedir();
  const baseDir = path.join(home, ".multipost-profiles");
  const chrome = detectChrome();
  const extension = resolveExtensionPath(args.extension);

  fs.mkdirSync(baseDir, { recursive: true });

  const isWin = os.platform() === "win32";
  const launcherName = isWin ? "start-all.bat" : "start-all.sh";
  const launcherPath = path.join(baseDir, launcherName);

  const lines = [];
  if (!isWin) lines.push("#!/usr/bin/env bash");

  for (let i = 1; i <= args.accounts; i++) {
    const profileDir = path.join(baseDir, `profile-${i}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const cmd = `"${chrome}" --user-data-dir="${profileDir}" --load-extension="${extension}"`;
    if (isWin) {
      lines.push(`start "" ${cmd}`);
    } else {
      lines.push(`${cmd} &`);
    }
  }

  fs.writeFileSync(launcherPath, `${lines.join("\n")}\n`, "utf8");
  if (!isWin) fs.chmodSync(launcherPath, 0o755);

  console.log("\n✅ MultiPost multi-profile setup complete\n");
  console.log(`   Profiles dir : ${baseDir}`);
  console.log(`   Chrome       : ${chrome}`);
  console.log(`   Extension    : ${extension}`);
  console.log(`   Launcher     : ${launcherPath}`);
  console.log(`   Account count: ${args.accounts}`);
  console.log("\n📋 Next steps:");
  console.log(`   1. Run the launcher: ${isWin ? launcherPath : `sh ${launcherPath}`}`);
  console.log("   2. In each Chrome window, log into the platform account you want");
  console.log("   3. Start the coordinator: pnpm dev:coordinator");
  console.log("   4. Use the publish page — it will now list accounts across all profiles\n");
}

main();
