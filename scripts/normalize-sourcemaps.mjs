#!/usr/bin/env node
/**
 * Makes `sam build` reproducible. SAM bundles each function in a randomly named temporary folder,
 * and esbuild writes source paths relative to it into every source map. The JavaScript is the
 * same from build to build but the maps are not, so every deploy looked like new code for all six
 * functions and published a new version of each. This rewrites those paths to be relative to the
 * project ("src/handlers/ingest.ts", "node_modules/..."), which also keeps the local user's
 * folder names out of the uploaded artifacts.
 *
 * Runs after `sam build` (npm run sam:build). Usage: node scripts/normalize-sourcemaps.mjs [buildDir]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const buildDir = process.argv[2] ?? '.aws-sam/build';

// "../../../../Users/me/AppData/Local/Temp/tmpab12cd34/src/x.ts" or "../../tmp/tmpab12cd34/src/x.ts"
const TEMP_BUILD_PREFIX = /^(?:\.\.\/)*(?:[^/]+\/)*?tmp[a-z0-9_]{6,}\//i;

function* sourceMaps(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceMaps(path);
    else if (name.endsWith('.js.map')) yield path;
  }
}

let changed = 0;
for (const path of sourceMaps(buildDir)) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  const sources = map.sources.map((source) => source.replace(TEMP_BUILD_PREFIX, ''));
  if (sources.some((source, i) => source !== map.sources[i])) {
    writeFileSync(path, JSON.stringify({ ...map, sources }));
    changed += 1;
  }
}
console.log(`Normalized source paths in ${changed} source map(s) under ${buildDir}`);
