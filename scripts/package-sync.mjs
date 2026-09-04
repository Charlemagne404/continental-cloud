import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = join(projectRoot, 'dist', 'public', 'downloads');
const targets = [
  ['win-x64', 'node24-win-x64', '.exe'],
  ['win-arm64', 'node24-win-arm64', '.exe'],
  ['macos-x64', 'node24-macos-x64', ''],
  ['macos-arm64', 'node24-macos-arm64', ''],
  ['linux-x64', 'node24-linux-x64', ''],
  ['linux-arm64', 'node24-linux-arm64', ''],
];

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'continental-cloud-sync-'));
const bundle = join(temporaryDirectory, 'cloud-sync.cjs');
try {
  await mkdir(outputDirectory, { recursive: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await run(join(projectRoot, 'node_modules', '.bin', 'esbuild'), ['dist/sync-cli.js', '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`]);
  for (const [name, target, extension] of targets) {
    const output = join(outputDirectory, `cloud-sync-${name}${extension}`);
    console.log(`Packaging ${target}…`);
    await run(join(projectRoot, 'node_modules', '.bin', 'pkg'), [bundle, '--no-signature', '--no-bytecode', '--public', `--targets=${target}`, `--output=${output}`]);
    await chmod(output, 0o755);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function run(file, args) {
  await execFile(file, args, { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
}
