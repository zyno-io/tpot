#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const version = process.argv[2];
if (!version) {
    console.error('Usage: scripts/release.mjs <version>');
    console.error('  e.g. scripts/release.mjs 0.3.0');
    process.exit(1);
}

if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/.test(version)) {
    console.error(`Invalid version: ${version}`);
    process.exit(1);
}

const packageFiles = [
    'package.json',
    'packages/server/package.json',
    'packages/client/package.json',
    'packages/e2e/package.json',
];

for (const rel of packageFiles) {
    const abs = resolve(root, rel);
    const pkg = JSON.parse(readFileSync(abs, 'utf8'));
    pkg.version = version;
    writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  bumped ${rel} → ${version}`);
}

const tag = `v${version}`;

execSync('git add -A', { cwd: root, stdio: 'inherit' });
execSync(`git commit -m "${tag}"`, { cwd: root, stdio: 'inherit' });
execSync(`git tag ${tag}`, { cwd: root, stdio: 'inherit' });
execSync(`git push && git push origin ${tag}`, { cwd: root, stdio: 'inherit' });

console.log(`\nReleased ${tag}`);
