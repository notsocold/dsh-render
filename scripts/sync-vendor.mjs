#!/usr/bin/env node
/**
 * sync-vendor.mjs — keep the browser-side vendor assets of dsh-render in sync.
 *
 * Sources (downloaded directly from the npm registry, no dependency install):
 *   - mermaid 12.2.0: dist/mermaid.esm.min.mjs + dist/chunks/mermaid.esm.min/*.mjs
 *   - echarts 6.1.0: dist/echarts.min.js
 *
 * The script is idempotent: every run rebuilds vendor/mermaid and vendor/echarts
 * from scratch. Downloads are staged in a temp directory and the new vendor
 * trees are assembled in hidden staging directories, so a failed run leaves the
 * previously synced assets untouched. Source maps, the large standalone
 * mermaid.js bundles and unrelated chunk directories are deliberately skipped.
 *
 * Requirements: Node.js >= 18 (ESM), curl and tar on PATH.
 * Usage: node scripts/sync-vendor.mjs [--keep-temp]
 *
 * This script never reads or writes package.json and never installs packages.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const VENDOR_DIR = path.join(ROOT_DIR, 'vendor');
const REGISTRY_BASE = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const KEEP_TEMP = process.argv.includes('--keep-temp');

const MERMAID = {
  name: 'mermaid',
  version: '12.2.0',
  tarballUrl: `${REGISTRY_BASE}/mermaid/-/mermaid-12.2.0.tgz`,
  minChunks: 30,
};

const ECHARTS = {
  name: 'echarts',
  version: '6.1.0',
  tarballUrl: `${REGISTRY_BASE}/echarts/-/echarts-6.1.0.tgz`,
  minBytes: 700_000,
};

const EXPECTED_TOTAL_MIN = 6 * 1024 * 1024;
const EXPECTED_TOTAL_MAX = 12 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

function assertPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to touch a path outside ${baseDir}: ${targetPath}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return fs.statSync(dest).size;
}

function fileSize(file) {
  return fs.statSync(file).size;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function runTool(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) {
    throw new Error(`failed to execute ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `${command} exited with status ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout;
}

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walkStats(full);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += fileSize(full);
    }
  }
  return { files, bytes };
}

function makeStagingDir(name) {
  const stage = path.join(VENDOR_DIR, `.staging-${name}-${process.pid}`);
  assertPathInside(VENDOR_DIR, stage);
  fs.rmSync(stage, { recursive: true, force: true });
  ensureDir(stage);
  return stage;
}

function writeVersionFile(dir, version) {
  const file = path.join(dir, 'VERSION');
  fs.writeFileSync(file, version);
  return fileSize(file);
}

/* -------------------------------------------------------------------------- */
/* Download + extract                                                         */
/* -------------------------------------------------------------------------- */

function downloadAndExtract(spec, tempRoot) {
  const tarball = path.join(tempRoot, `${spec.name}-${spec.version}.tgz`);
  console.log(`[vendor] downloading ${spec.name}@${spec.version}`);
  console.log(`         ${spec.tarballUrl}`);
  runTool('curl', [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '--connect-timeout',
    '30',
    '--max-time',
    '900',
    '--output',
    tarball,
    spec.tarballUrl,
  ]);

  const tarballBytes = fileSize(tarball);
  if (tarballBytes < 100_000) {
    throw new Error(`${spec.name}: downloaded tarball is suspiciously small (${tarballBytes} bytes)`);
  }

  const extractDir = ensureDir(path.join(tempRoot, `${spec.name}-extract`));
  console.log(`[vendor] extracting ${spec.name} (${formatBytes(tarballBytes)})`);
  runTool('tar', ['-xzf', tarball, '-C', extractDir]);

  const packageDir = path.join(extractDir, 'package');
  if (!fs.existsSync(packageDir)) {
    throw new Error(`${spec.name}: tarball does not contain a package/ directory`);
  }

  const manifestFile = path.join(packageDir, 'package.json');
  if (!isFile(manifestFile)) {
    throw new Error(`${spec.name}: package/package.json is missing from the tarball`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== spec.version) {
    throw new Error(
      `${spec.name}: expected version ${spec.version}, tarball contains ${manifest.version}`,
    );
  }

  return { packageDir, tarballBytes, manifest };
}

/* -------------------------------------------------------------------------- */
/* Mermaid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Copy only the on-demand ESM chunks (*.mjs). Source maps are intentionally
 * excluded: in Mermaid 12.2.0 they account for ~18 MiB of the 24 MiB chunk
 * directory and are not needed by the browser at runtime.
 */
function copyMermaidChunks(srcDir, destDir) {
  let files = 0;
  let bytes = 0;
  let skippedMaps = 0;
  let skippedMapBytes = 0;
  let skippedOther = 0;

  const pending = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop();
    const absoluteDir = path.join(srcDir, relativeDir);
    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relative = path.join(relativeDir, entry.name);
      const source = path.join(srcDir, relative);
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;

      if (entry.name.endsWith('.map')) {
        skippedMaps += 1;
        skippedMapBytes += fileSize(source);
        continue;
      }
      if (!entry.name.endsWith('.mjs')) {
        skippedOther += 1;
        continue;
      }

      files += 1;
      bytes += copyFile(source, path.join(destDir, relative));
    }
  }

  return { files, bytes, skippedMaps, skippedMapBytes, skippedOther };
}

function buildMermaidStage(packageDir) {
  const stage = makeStagingDir(MERMAID.name);
  const target = [];
  const entrySource = path.join(packageDir, 'dist', 'mermaid.esm.min.mjs');
  const chunksSource = path.join(packageDir, 'dist', 'chunks', 'mermaid.esm.min');
  const licenseSource = path.join(packageDir, 'LICENSE');
  const manifestSource = path.join(packageDir, 'package.json');

  for (const [label, source] of [
    ['dist/mermaid.esm.min.mjs', entrySource],
    ['dist/chunks/mermaid.esm.min', chunksSource],
    ['LICENSE', licenseSource],
    ['package.json', manifestSource],
  ]) {
    if (!fs.existsSync(source)) throw new Error(`mermaid: missing upstream file ${label}`);
  }
  if (!fs.statSync(chunksSource).isDirectory()) {
    throw new Error('mermaid: upstream chunk path is not a directory');
  }

  const entryTarget = path.join(stage, 'dist', 'mermaid.esm.min.mjs');
  const entryBytes = copyFile(entrySource, entryTarget);
  target.push({ rel: 'dist/mermaid.esm.min.mjs', bytes: entryBytes });

  const chunksTarget = path.join(stage, 'dist', 'chunks', 'mermaid.esm.min');
  ensureDir(chunksTarget);
  const chunks = copyMermaidChunks(chunksSource, chunksTarget);
  target.push({
    rel: 'dist/chunks/mermaid.esm.min/',
    bytes: chunks.bytes,
    files: chunks.files,
  });

  target.push({ rel: 'LICENSE', bytes: copyFile(licenseSource, path.join(stage, 'LICENSE')) });
  target.push({
    rel: 'package.json',
    bytes: copyFile(manifestSource, path.join(stage, 'package.json')),
  });
  target.push({ rel: 'VERSION', bytes: writeVersionFile(stage, MERMAID.version) });

  // The entry module must keep using relative chunk imports; otherwise the
  // vendored tree is not self-contained and must not be published.
  const head = fs.readFileSync(entryTarget, 'utf8').slice(0, 8192);
  if (!head.includes('./chunks/mermaid.esm.min/')) {
    throw new Error('mermaid: entry module does not reference ./chunks/mermaid.esm.min/');
  }
  if (chunks.files < MERMAID.minChunks) {
    throw new Error(
      `mermaid: only ${chunks.files} ESM chunks were copied (expected >= ${MERMAID.minChunks})`,
    );
  }
  if (chunks.skippedOther > 0) {
    console.warn(`[vendor] warning: mermaid skipped ${chunks.skippedOther} non-.mjs file(s)`);
  }

  return {
    name: MERMAID.name,
    version: MERMAID.version,
    stage,
    target,
    chunks,
    stats: walkStats(stage),
  };
}

/* -------------------------------------------------------------------------- */
/* ECharts                                                                    */
/* -------------------------------------------------------------------------- */

function copyEchartsLicense(packageDir, stage) {
  for (const candidate of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    const source = path.join(packageDir, candidate);
    if (isFile(source)) {
      return { rel: 'LICENSE', bytes: copyFile(source, path.join(stage, 'LICENSE')) };
    }
  }

  const fallback = [
    `ECharts ${ECHARTS.version}`,
    '',
    'ECharts is licensed under the Apache License, Version 2.0.',
    'https://github.com/apache/echarts/blob/6.1.0/LICENSE',
    '',
    `Source: ${ECHARTS.tarballUrl}`,
    '',
  ].join('\n');
  const file = path.join(stage, 'LICENSE.txt');
  fs.writeFileSync(file, fallback);
  return { rel: 'LICENSE.txt', bytes: fileSize(file) };
}

/**
 * Apache-2.0 redistribution: echarts.min.js itself points at the NOTICE file,
 * and the package ships third-party notices (licenses/LICENSE-d3) for code
 * embedded in the bundle. Both are tiny and are kept next to the LICENSE.
 */
function copyEchartsNotices(packageDir, stage) {
  const targets = [];

  const noticeSource = path.join(packageDir, 'NOTICE');
  if (isFile(noticeSource)) {
    targets.push({ rel: 'NOTICE', bytes: copyFile(noticeSource, path.join(stage, 'NOTICE')) });
  }

  const licensesSource = path.join(packageDir, 'licenses');
  if (fs.existsSync(licensesSource) && fs.statSync(licensesSource).isDirectory()) {
    let files = 0;
    let bytes = 0;
    const pending = [''];
    while (pending.length > 0) {
      const relativeDir = pending.pop();
      for (const entry of fs.readdirSync(path.join(licensesSource, relativeDir), {
        withFileTypes: true,
      })) {
        const relative = path.join(relativeDir, entry.name);
        const source = path.join(licensesSource, relative);
        if (entry.isDirectory()) {
          pending.push(relative);
        } else if (entry.isFile()) {
          files += 1;
          bytes += copyFile(source, path.join(stage, 'licenses', relative));
        }
      }
    }
    if (files > 0) targets.push({ rel: 'licenses/', bytes, files });
  }

  return targets;
}

function buildEchartsStage(packageDir) {
  const stage = makeStagingDir(ECHARTS.name);
  const target = [];
  const scriptSource = path.join(packageDir, 'dist', 'echarts.min.js');

  if (!isFile(scriptSource)) {
    throw new Error('echarts: missing upstream file dist/echarts.min.js');
  }

  const scriptBytes = copyFile(scriptSource, path.join(stage, 'echarts.min.js'));
  if (scriptBytes < ECHARTS.minBytes) {
    throw new Error(
      `echarts: dist/echarts.min.js is only ${scriptBytes} bytes (expected >= ${ECHARTS.minBytes})`,
    );
  }
  target.push({ rel: 'echarts.min.js', bytes: scriptBytes });
  target.push(copyEchartsLicense(packageDir, stage));
  target.push(...copyEchartsNotices(packageDir, stage));
  target.push({ rel: 'VERSION', bytes: writeVersionFile(stage, ECHARTS.version) });

  return {
    name: ECHARTS.name,
    version: ECHARTS.version,
    stage,
    target,
    stats: walkStats(stage),
  };
}

/* -------------------------------------------------------------------------- */
/* Publish + report                                                           */
/* -------------------------------------------------------------------------- */

function publish(built) {
  const destination = path.join(VENDOR_DIR, built.name);
  assertPathInside(VENDOR_DIR, destination);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(built.stage, destination);
  return destination;
}

function printReport(packages, chunks) {
  console.log('\n[vendor] synced targets:');
  let totalFiles = 0;
  let totalBytes = 0;

  for (const pkg of packages) {
    const destination = path.join(VENDOR_DIR, pkg.name);
    const stats = walkStats(destination);
    totalFiles += stats.files;
    totalBytes += stats.bytes;

    console.log(
      `\n  vendor/${pkg.name}/  (${pkg.name}@${pkg.version}, ${stats.files} files, ` +
        `${stats.bytes} bytes, ${formatBytes(stats.bytes)})`,
    );
    for (const item of pkg.target) {
      const suffix = item.files === undefined ? '' : `  [${item.files} files]`;
      console.log(
        `    ${(pkg.name + '/' + item.rel).padEnd(54)} ${String(item.bytes).padStart(10)} bytes${suffix}`,
      );
    }
    if (pkg.name === MERMAID.name) {
      console.log(
        `    skipped source maps: ${chunks.skippedMaps} files, ` +
          `${chunks.skippedMapBytes} bytes (${formatBytes(chunks.skippedMapBytes)})`,
      );
    }
  }

  console.log(
    `\n[vendor] total: ${totalFiles} files, ${totalBytes} bytes (${formatBytes(totalBytes)})`,
  );

  if (totalBytes < EXPECTED_TOTAL_MIN || totalBytes > EXPECTED_TOTAL_MAX) {
    console.warn(
      `[vendor] warning: total size is outside the expected 6-12 MiB range ` +
        `(${formatBytes(EXPECTED_TOTAL_MIN)} - ${formatBytes(EXPECTED_TOTAL_MAX)})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  ensureDir(VENDOR_DIR);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-vendor-'));
  const stages = [];

  try {
    // Download and validate both packages before touching any existing vendor
    // directory, so network/version failures never leave a half-synced tree.
    const mermaidSource = downloadAndExtract(MERMAID, tempRoot);
    const echartsSource = downloadAndExtract(ECHARTS, tempRoot);

    const mermaid = buildMermaidStage(mermaidSource.packageDir);
    stages.push(mermaid.stage);
    const echarts = buildEchartsStage(echartsSource.packageDir);
    stages.push(echarts.stage);

    for (const built of [mermaid, echarts]) {
      publish(built);
      const stageIndex = stages.indexOf(built.stage);
      if (stageIndex !== -1) stages.splice(stageIndex, 1);
    }

    printReport([mermaid, echarts], mermaid.chunks);
    console.log('\n[vendor] done.');
  } catch (error) {
    console.error(`\n[vendor] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    for (const stage of stages) {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    // Safety net: a builder can throw after creating its staging directory but
    // before returning its path to `stages`.
    const stagingSuffix = `-${process.pid}`;
    for (const entry of fs.readdirSync(VENDOR_DIR)) {
      if (entry.startsWith('.staging-') && entry.endsWith(stagingSuffix)) {
        fs.rmSync(path.join(VENDOR_DIR, entry), { recursive: true, force: true });
      }
    }
    if (KEEP_TEMP) {
      console.log(`[vendor] keeping temp directory: ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main();
