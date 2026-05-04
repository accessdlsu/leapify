#!/usr/bin/env node

/**
 * Clean old build artifacts before packaging.
 * Removes: *.tgz files in project root, dist/ directory.
 */

import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

// Remove old .tgz packages
const tgzFiles = readdirSync(root).filter((f) => f.endsWith(".tgz"));
for (const file of tgzFiles) {
  rmSync(join(root, file));
  console.log(`Removed ${file}`);
}

// Remove dist/
const distPath = join(root, "dist");
if (existsSync(distPath)) {
  rmSync(distPath, { recursive: true });
  console.log("Removed dist/");
}

if (tgzFiles.length === 0 && !existsSync(distPath)) {
  console.log("Nothing to clean.");
}
