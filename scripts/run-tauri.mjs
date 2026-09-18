import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
const cargoBin = path.join(cargoHome, "bin");
const cargoExe = path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
if (!fs.existsSync(cargoExe)) {
  console.error(`[run-tauri] cargo not found at ${cargoExe}`);
  console.error("Install Rust from https://rustup.rs and reopen the terminal.");
  process.exit(1);
}

process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH || ""}`;

const args = process.argv.slice(2);
const require = createRequire(import.meta.url);
let tauriEntry;

try {
  tauriEntry = require.resolve("@tauri-apps/cli/tauri.js");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[run-tauri] Tauri CLI entry not found: ${message}`);
  process.exit(1);
}

const child = spawn(process.execPath, [tauriEntry, ...args], {
  stdio: "inherit",
  shell: false,
  env: process.env,
});

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  process.exitCode = code;
};

child.once("error", (error) => {
  console.error(`[run-tauri] failed to start Tauri CLI: ${error.message}`);
  finish(1);
});

child.once("exit", (code, signal) => {
  finish(signal ? 1 : code ?? 1);
});
