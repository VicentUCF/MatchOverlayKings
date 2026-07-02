import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const { app } = await buildApp(config);

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`KPL Live Overlay Control listening at ${address}`);
  app.log.info(`Control: ${address}/control/pista-1`);
  app.log.info(`Overlay: ${address}/overlay/pista-1/scoreboard`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
