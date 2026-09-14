import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const { app } = await buildApp(config);
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Stopping KPL local production server');
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, 'KPL local production server did not stop cleanly');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`KPL Live Overlay Control listening at ${address}`);
  app.log.info(`Control: ${address}/control/pista-1`);
  app.log.info(`Overlay: ${address}/overlay/pista-1/scoreboard`);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
