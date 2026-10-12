import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildApp } from '@kpl/server/bootstrap';
import { readConfig } from '@kpl/server/config';

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => { BrowserWindow.getAllWindows()[0]?.focus(); });

const port = 4310;
let runtime: Awaited<ReturnType<typeof buildApp>> | null = null;
let closing = false;

function productionAddress(): { host: string; cidr: string } | null {
  const configured = process.env.KPL_PILOT_LAN_HOST;
  const entries = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map((entry) => ({ ...entry, name })));
  const candidates = entries.filter((entry) => entry.family === 'IPv4' && !entry.internal && entry.cidr
    && (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)))
    .sort((a, b) => Number(/vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V/i.test(a.name))
      - Number(/vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V/i.test(b.name)));
  const selected = configured ? candidates.find((entry) => entry.address === configured) : candidates[0];
  return selected?.cidr ? { host: selected.address, cidr: selected.cidr } : null;
}

function packagedConfig(bin: string): { supabaseUrl?: string; publishableKey?: string; browser?: string } {
  try { return JSON.parse(readFileSync(join(bin, 'production-config.json'), 'utf8')) as Record<string, string>; }
  catch { return {}; }
}

async function start(): Promise<void> {
  const bin = app.isPackaged ? process.resourcesPath + '/bin' : resolve(import.meta.dirname, '../vendor');
  const bundle = packagedConfig(bin);
  process.env.VITE_SUPABASE_URL ||= bundle.supabaseUrl ?? '';
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= bundle.publishableKey ?? '';
  process.env.KPL_PILOT_CHROMIUM_PATH ||= bundle.browser ? join(bin, bundle.browser) : '';
  const dataDir = app.getPath('userData');
  const credentialsPath = join(dataDir, 'youtube-client.json');
  const lan = productionAddress();
  const config = readConfig();
  const ffmpegPath = process.env.KPL_PILOT_FFMPEG_PATH ?? join(bin, 'ffmpeg.exe');
  const mediaMtxPath = process.env.KPL_PILOT_MEDIAMTX_PATH ?? join(bin, 'mediamtx.exe');
  config.host = '0.0.0.0';
  config.port = port;
  config.dataDir = dataDir;
  config.webDistDir = app.isPackaged ? join(process.resourcesPath, 'web') : resolve(import.meta.dirname, '../../web/dist');
  config.rabbitMq = null;
  config.pilot.ffmpegPath = ffmpegPath;
  config.pilot.recordingOnly = true;
  config.pilot.defaultRecordingDirectory = join(app.getPath('documents'), 'KPL Grabaciones');
  config.pilot.mobileCamera = {
    ...config.pilot.mobileCamera!, mediaMtxPath: existsSync(mediaMtxPath) ? mediaMtxPath : null,
    lanHost: lan?.host ?? null, lanCidr: lan?.cidr ?? null, adminHost: '127.0.0.1',
  };
  config.pilot.youtube = {
    ...config.pilot.youtube,
    ...readGoogleCredentials(existsSync(credentialsPath) ? credentialsPath : null),
    tokenPath: join(dataDir, 'youtube-token.json'),
    redirectUri: `http://localhost:${port}/api/pilot/youtube/auth/callback`,
  };
  await mkdir(config.pilot.defaultRecordingDirectory, { recursive: true });
  runtime = await buildApp(config);
  try { await runtime.app.listen({ host: config.host, port: config.port }); }
  catch (error) { await runtime.app.close(); runtime = null; throw error; }

  ipcMain.handle('recording:open', (_event, id: unknown) => {
    const asset = typeof id === 'string' ? runtime?.recordings.listAssets().find((item) => item.id === id) : null;
    if (!asset) throw new Error('Grabación no encontrada.');
    shell.showItemInFolder(asset.path);
    return true;
  });
  ipcMain.handle('recording:export', async (_event, id: unknown) => {
    const asset = typeof id === 'string' ? runtime?.recordings.listAssets().find((item) => item.id === id) : null;
    if (!asset || asset.state !== 'ready') throw new Error('La grabación todavía no está lista.');
    const choice = await dialog.showSaveDialog({ title: 'Exportar MP4', defaultPath: basename(asset.path),
      filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }] });
    if (choice.canceled || !choice.filePath) return false;
    await copyFile(asset.path, choice.filePath);
    return true;
  });
  ipcMain.handle('youtube:import-credentials', async () => {
    const choice = await dialog.showOpenDialog({ title: 'Importar cliente OAuth de YouTube', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths[0]) return false;
    const source = choice.filePaths[0];
    const parsed = JSON.parse(await readFile(source, 'utf8')) as { web?: { client_id?: unknown; client_secret?: unknown } };
    if (typeof parsed.web?.client_id !== 'string' || typeof parsed.web.client_secret !== 'string')
      throw new Error('El archivo no contiene un cliente OAuth web válido.');
    await mkdir(dataDir, { recursive: true });
    await copyFile(source, credentialsPath);
    await dialog.showMessageBox({ type: 'info', message: 'Credenciales importadas. Reinicia KPL Producción para conectar YouTube.' });
    return true;
  });

  const win = new BrowserWindow({ width: 1500, height: 950, minWidth: 1050, minHeight: 700,
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}/api/pilot/youtube/auth/start`)
      || url.startsWith(`http://localhost:${port}/api/pilot/youtube/auth/start`)) {
      void shell.openExternal(url);
    }
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`) && !url.startsWith(`http://localhost:${port}/`)) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
  await win.loadURL(`http://127.0.0.1:${port}/admin`);
}

function readGoogleCredentials(path: string | null): { clientId: string; clientSecret: string } | object {
  if (!path) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { web?: { client_id?: string; client_secret?: string } };
    return data.web?.client_id && data.web.client_secret
      ? { clientId: data.web.client_id, clientSecret: data.web.client_secret } : {};
  } catch { return {}; }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing || !runtime) return;
  event.preventDefault();
  closing = true;
  void runtime.app.close().catch((error: unknown) => {
    dialog.showErrorBox('No se pudo cerrar toda la captura', error instanceof Error ? error.message : String(error));
  }).finally(() => { runtime = null; app.quit(); });
});
if (ownsInstance) void app.whenReady().then(start).catch((error: unknown) => {
  dialog.showErrorBox('KPL Producción no pudo arrancar', error instanceof Error ? error.message : String(error));
  app.quit();
});
