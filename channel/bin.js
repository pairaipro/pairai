#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve tsx from this package's node_modules as a file:// URL
const tsxPath = pathToFileURL(require.resolve("tsx")).href;
const script = join(__dirname, "pairai.ts");

const result = spawnSync(process.execPath, ["--import", tsxPath, script, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
