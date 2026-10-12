import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import ffprobe from '@ffprobe-installer/ffprobe';
import { chromium } from 'playwright';

const crossBuild = process.platform !== 'win32' && process.env.KPL_CROSS_BUILD_WIN === '1';
if (process.platform !== 'win32' && !crossBuild) throw new Error('Compila en Windows x64 o define KPL_CROSS_BUILD_WIN=1 para una compilación cruzada.');
if (crossBuild && process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE !== 'win64')
  throw new Error('La compilación cruzada requiere PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=win64.');
const root = resolve(import.meta.dirname, '..');
const vendor = join(root, 'vendor');
await mkdir(vendor, { recursive: true });
const binaryDirectory = crossBuild ? process.env.KPL_WIN_BINARIES_DIR : null;
if (crossBuild && !binaryDirectory) throw new Error('Define KPL_WIN_BINARIES_DIR con los paquetes Windows de FFmpeg y FFprobe.');
await copyFile(binaryDirectory ? join(binaryDirectory, '@ffmpeg-installer/win32-x64/ffmpeg.exe') : ffmpeg.path,
  join(vendor, 'ffmpeg.exe'));
await copyFile(binaryDirectory ? join(binaryDirectory, '@ffprobe-installer/win32-x64/ffprobe.exe') : ffprobe.path,
  join(vendor, 'ffprobe.exe'));
if (binaryDirectory) {
  const nativeTarget = resolve(root, '../../node_modules/@resvg/resvg-js-win32-x64-msvc');
  await cp(join(binaryDirectory, '@resvg/resvg-js-win32-x64-msvc'), nativeTarget, { recursive: true });
}

const browserExe = chromium.executablePath();
if (!existsSync(browserExe)) throw new Error('Falta Chromium: ejecuta npx playwright install chromium en Windows.');
const browserRoot = dirname(dirname(browserExe));
const browserTarget = join(vendor, 'browser', basename(browserRoot));
await cp(browserRoot, browserTarget, { recursive: true });

const version = '1.21.0';
const filename = `mediamtx_v${version}_windows_amd64.zip`;
const base = `https://github.com/bluenviron/mediamtx/releases/download/v${version}`;
const [archive, checksums] = await Promise.all([
  download(`${base}/${filename}`), download(`${base}/checksums.sha256`),
]);
const expected = checksums.toString('utf8').split(/\r?\n/).map((line) => line.trim().split(/\s+/))
  .find((parts) => parts?.[1]?.replace(/^\*/, '') === filename)?.[0];
if (!expected || !/^[a-f0-9]{64}$/i.test(expected)
  || createHash('sha256').update(archive).digest('hex').toLowerCase() !== expected.toLowerCase()) {
  throw new Error('No se pudo verificar la firma SHA-256 de MediaMTX.');
}
const zipPath = join(tmpdir(), `kpl-${filename}`);
await writeFile(zipPath, archive);
const extracted = join(tmpdir(), `kpl-mediamtx-${process.pid}`);
await mkdir(extracted, { recursive: true });
const tar = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'unzip',
  process.platform === 'win32' ? ['-xf', zipPath, '-C', extracted] : ['-q', zipPath, '-d', extracted],
  { encoding: 'utf8' });
if (tar.status !== 0) throw new Error(`No se pudo extraer MediaMTX: ${tar.stderr}`);
await copyFile(join(extracted, 'mediamtx.exe'), join(vendor, 'mediamtx.exe'));

const webEnv = await readFile(resolve(root, '../web/.env'), 'utf8').catch(() => '');
const setting = (key) => process.env[key] ?? webEnv.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const supabaseUrl = setting('VITE_SUPABASE_URL');
const publishableKey = setting('VITE_SUPABASE_PUBLISHABLE_KEY');
if (!supabaseUrl || !publishableKey) throw new Error('Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY antes de empaquetar.');
await writeFile(join(vendor, 'production-config.json'), JSON.stringify({
  supabaseUrl, publishableKey, browser: relative(vendor, join(browserTarget, relative(browserRoot, browserExe))),
}, null, 2));

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
