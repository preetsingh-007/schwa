// Copies the ONNX Runtime Web WASM binaries that Transformers.js needs into
// public/ort/ so they are served from our own origin (and pre-cached by the
// service worker) instead of a CDN. This is what makes the engine work offline.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
const dest = join(root, 'public', 'ort');
mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs')));
for (const f of files) cpSync(join(src, f), join(dest, f));
console.log(`[copy-ort] copied ${files.length} files to public/ort`);
