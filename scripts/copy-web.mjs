// Copy static web assets next to the compiled output so the production server
// (dist/index.js) can serve them from dist/web/public. Works on any platform.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'web');
const dest = join(root, 'dist', 'web');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`Copied web assets to ${dest}`);
