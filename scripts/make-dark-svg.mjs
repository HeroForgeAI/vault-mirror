#!/usr/bin/env node
// Makes each docs/assets/*-dark.svg from its *-light.svg by swapping colour values only,
// so the two files can never drift in layout. Run: node scripts/make-dark-svg.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');
/** GitHub's own light and dark values, the one accent, and the marker behind a matched word. */
const SWAP = { '#1f2328': '#f0f6fc', '#59636e': '#9198a1', '#d1d9e0': '#3d444d', '#f6f8fa': '#151b23', '#8250df': '#ab7df8', '#fff8c5': '#5c4a14' };

for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('-light.svg'))) {
  const light = fs.readFileSync(path.join(dir, name), 'utf8');
  const dark = light.replace(/#[0-9a-f]{6}/gi, (c) => SWAP[c.toLowerCase()] || c);
  fs.writeFileSync(path.join(dir, name.replace('-light.svg', '-dark.svg')), dark);
  console.log(`${name} -> ${name.replace('-light.svg', '-dark.svg')}`);
}
