#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultOutDir = path.join(rootDir, 'tracy-ui');
const defaultBaseUrl = 'https://tracy.nereid.pl';

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.outDir ?? defaultOutDir);
const baseUrl = (args.baseUrl ?? defaultBaseUrl).replace(/\/$/, '');

const assets = [
  { source: 'index.html', target: 'index.html', compressed: false },
  { source: 'favicon.svg', target: 'favicon.svg', compressed: false },
  { source: 'tracy-profiler.data', target: 'tracy-profiler.data', compressed: false },
  { source: 'tracy-profiler.js.gz', target: 'tracy-profiler.js', compressed: true },
  { source: 'tracy-profiler.wasm.gz', target: 'tracy-profiler.wasm', compressed: true },
];

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const metadata = {
  baseUrl,
  fetchedAt: new Date().toISOString(),
  assets: [],
};

for (const asset of assets) {
  const url = `${baseUrl}/${asset.source}`;
  const targetPath = path.join(outDir, asset.target);
  const tempPath = `${targetPath}.download`;
  const headersPath = `${targetPath}.headers`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  console.log(`Fetching ${url}`);

  await execFileAsync('curl', [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--dump-header',
    headersPath,
    '--output',
    tempPath,
    url,
  ]);

  if (asset.compressed) {
    await pipeline(createReadStream(tempPath), createGunzip(), createWriteStream(targetPath));
    await fs.rm(tempPath, { force: true });
  } else {
    await fs.rename(tempPath, targetPath);
  }

  const responseHeaders = parseHeaders(await fs.readFile(headersPath, 'utf8'));
  await fs.rm(headersPath, { force: true });
  metadata.assets.push({
    source: asset.source,
    target: asset.target,
    etag: responseHeaders.etag ?? null,
    lastModified: responseHeaders['last-modified'] ?? null,
  });
}

await fs.writeFile(path.join(outDir, 'VERSION.json'), `${JSON.stringify(metadata, null, 2)}\n`);

const totalBytes = await getTotalBytes(outDir);
console.log(`Fetched Tracy UI into ${outDir}`);
console.log(`Assets: ${assets.length}`);
console.log(`Size: ${totalBytes} bytes`);

async function getTotalBytes(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await getTotalBytes(fullPath);
      continue;
    }

    total += (await fs.stat(fullPath)).size;
  }

  return total;
}

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      result.outDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--base-url') {
      result.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function parseHeaders(rawHeaders) {
  const sections = rawHeaders
    .split(/\r?\n\r?\n/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const lastSection = sections.at(-1) ?? '';
  const headers = {};

  for (const line of lastSection.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function printUsage() {
  console.log(`Usage: node ./scripts/fetch-tracy-ui.mjs [options]

Options:
  --out DIR         Output directory, default: ./tracy-ui
  --base-url URL    Tracy UI base URL, default: https://tracy.nereid.pl
  -h, --help        Show this help`);
}
