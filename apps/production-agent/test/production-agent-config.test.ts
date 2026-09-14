import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProductionAgentConfig } from '../src/index.js';
import { COURT_IDS, productionEnvironment, productionMediaConfig } from './production-agent-fixture.js';

const temporaryDirectories: string[] = [];

async function writeMediaConfig(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-production-agent-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'media.json');
  await writeFile(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  return path;
}

describe('production agent configuration boundary', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
  });

  it('loads external JSON into the existing typed runtime schemas', async () => {
    // Given
    const mediaConfigPath = await writeMediaConfig(productionMediaConfig());

    // When
    const config = await loadProductionAgentConfig(productionEnvironment(), mediaConfigPath);

    // Then
    expect(config.agent.courtIds).toEqual(COURT_IDS);
    expect(config.media.courtIds).toEqual(COURT_IDS);
    expect(JSON.stringify(config)).not.toContain('agent-access-example');
  });

  it('rejects a relative media configuration path without using a default', async () => {
    // Given
    const relativePath = 'media.json';

    // When
    const load = () => loadProductionAgentConfig(productionEnvironment(), relativePath);

    // Then
    await expect(load).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('rejects a media configuration for a different court set', async () => {
    // Given
    const otherCourts = [...COURT_IDS.slice(0, 3), '10000000-0000-4000-8000-000000000099'];
    const mediaConfigPath = await writeMediaConfig(productionMediaConfig(otherCourts));

    // When
    const load = () => loadProductionAgentConfig(productionEnvironment(), mediaConfigPath);

    // Then
    await expect(load).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
