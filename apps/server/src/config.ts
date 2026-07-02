import { resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  webDistDir: string;
  controlPin: string | null;
}

export function readConfig(): ServerConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4300),
    dataDir: process.env.KPL_DATA_DIR
      ? resolve(process.env.KPL_DATA_DIR)
      : resolve(process.cwd(), '../../data'),
    webDistDir: process.env.KPL_WEB_DIST
      ? resolve(process.env.KPL_WEB_DIST)
      : resolve(process.cwd(), '../web/dist'),
    controlPin: process.env.KPL_CONTROL_PIN?.trim() || null,
  };
}
