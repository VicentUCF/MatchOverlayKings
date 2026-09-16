import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function check(mode: string, runtimes = 'nvidia') {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-compose-gpu-'));
  directories.push(directory);
  const envPath = join(directory, 'pilot.env');
  const outputPath = join(directory, 'compose.json');
  await writeFile(envPath, [
    'VITE_SUPABASE_URL=https://example.supabase.co', 'VITE_SUPABASE_PUBLISHABLE_KEY=test',
    'KPL_PILOT_LAN_HOST=192.168.1.20', 'KPL_PILOT_LAN_CIDR=192.168.1.0/24',
    'KPL_PILOT_CAMERA_PAGE_ORIGIN=https://example.com', `KPL_PILOT_GPU=${mode}`,
  ].join('\n'));
  await writeFile(join(directory, 'nvidia-smi'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  await writeFile(join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'info') { process.stdout.write(process.env.TEST_RUNTIMES); process.exit(0); }
const files = args.flatMap((arg, index) => arg === '-f' ? [args[index + 1]] : []);
fs.writeFileSync(process.env.TEST_COMPOSE_OUTPUT, JSON.stringify({args, files, contents: files.map(file => fs.readFileSync(file, 'utf8'))}));
`, { mode: 0o700 });
  await exec('bash', [resolve('scripts/local-production.sh'), 'check'], { env: {
    ...process.env, PATH: `${directory}:${process.env.PATH}`, KPL_LOCAL_PRODUCTION_ENV: envPath,
    KPL_PILOT_GPU: mode, TEST_RUNTIMES: runtimes, TEST_COMPOSE_OUTPUT: outputPath,
  } });
  return JSON.parse(await readFile(outputPath, 'utf8')) as { args: string[]; files: string[]; contents: string[] };
}

describe('Docker GPU access', () => {
  it('automatically requests NVIDIA devices and video driver libraries when the runtime is available', async () => {
    const result = await check('auto');
    expect(result.contents).toHaveLength(2);
    expect(result.contents[1]).toContain('NVIDIA_DRIVER_CAPABILITIES: compute,video,utility');
    expect(result.contents[1]).toContain('driver: nvidia');
    expect(result.args).toContain('--quiet');
    // The generated Compose override must be cleaned even after the CLI exits.
    await expect(readFile(result.files[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes Docker Desktop GPU support without a named nvidia runtime', async () => {
    const result = await check('auto', 'runc Docker Desktop');
    expect(result.contents[1]).toContain('driver: nvidia');
  });

  it('keeps the default Compose free of GPU requirements when access is disabled', async () => {
    const result = await check('off');
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).not.toContain('driver: nvidia');
  });

  it('rejects unknown modes rather than silently ignoring the requested configuration', async () => {
    await expect(check('invalid')).rejects.toThrow('KPL_PILOT_GPU debe ser');
  });
});
