import { pathToFileURL } from 'node:url';
import { ObservedStateProjector } from './observed-state-projection.js';
import {
  NodeProductionSignalSource,
  ProductionAgentLifecycle,
} from './production-agent-lifecycle.js';
import { composeProductionAgent } from './production-composition.js';
import {
  loadProductionAgentConfig,
  ProductionAgentConfigError,
} from './production-agent-config.js';
import { ProductionReconciliationLoop } from './production-reconciliation-loop.js';
import { NodeScheduler } from './process-stop.js';

export async function runProductionAgent(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const [mediaConfigPath, extraArgument] = args;
  if (mediaConfigPath === undefined || extraArgument !== undefined) {
    throw new ProductionAgentConfigError();
  }
  const config = await loadProductionAgentConfig(environment, mediaConfigPath);
  const composition = composeProductionAgent(config);
  const scheduler = new NodeScheduler();
  const loop = new ProductionReconciliationLoop({
    controlPlane: composition.controlPlane,
    supervisor: composition.supervisor,
    projector: new ObservedStateProjector(),
    scheduler,
    clock: { nowMs: () => Date.now() },
    logger: composition.logger,
    courtIds: [
      composition.courts[0].courtId,
      composition.courts[1].courtId,
      composition.courts[2].courtId,
      composition.courts[3].courtId,
    ],
    pollIntervalMs: config.agent.pollIntervalMs,
  });
  await new ProductionAgentLifecycle({
    mediaService: composition.mediaService,
    supervisor: composition.supervisor,
    loop,
    scheduler,
    signals: new NodeProductionSignalSource(),
    logger: composition.logger,
    shutdownDeadlineMs: config.agent.shutdownDeadlineMs,
    hardExit: () => process.exit(1),
  }).run();
}

const executablePath = process.argv[1];
if (executablePath !== undefined && import.meta.url === pathToFileURL(executablePath).href) {
  void runProductionAgent(process.argv.slice(2), process.env).catch(() => {
    process.stderr.write('Production agent stopped with an error\n');
    process.exitCode = 1;
  });
}
