#!/usr/bin/env node

/**
 * Auto-version script — bump package.json version as 0.YYMMDD.N
 *
 * Format: Major.YYMMDD.RevisionOfTheDay
 * Examples: 0.260502.1, 0.260502.2, 0.260503.1
 *
 * Called automatically by `npm run version:auto`.
 */

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const now = new Date();
const major = pkg.version.split(".")[0]; // "0"
const yy = String(now.getFullYear()).slice(2); // "26"
const mm = String(now.getMonth() + 1).padStart(2, "0"); // "05"
const dd = String(now.getDate()).padStart(2, "0"); // "02"
const today = `${yy}${mm}${dd}`; // "260502"

const lastDate = pkg.version.split(".")[1] || "";
const lastRevision = parseInt(pkg.version.split(".")[2] || "0");

const revision = lastDate === today ? lastRevision + 1 : 1;

pkg.version = `${major}.${today}.${revision}`;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(`Version bumped to ${pkg.version}`);
