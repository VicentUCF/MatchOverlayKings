import { describe, expect, it } from 'vitest';
import {
  buildMediaMtxCommand,
  buildMediaMtxConfigYaml,
  buildMediaMtxPlan,
} from '../src/mediamtx-plan.js';
import { mediaConfig } from './mediamtx-service-fixture.js';

const apiUser = {
  username: 'api-user',
  passwordHash: `sha256:${'A'.repeat(43)}=`,
} as const;

describe('MediaMTX planner composition', () => {
  it('preserves the combined plan while allowing config creation before its path exists', () => {
    // Given
    const config = mediaConfig();
    const configPath = '/run/user/1000/kpl-agent/owned/mediamtx.yml';

    // When
    const configYaml = buildMediaMtxConfigYaml(config, apiUser);
    const command = buildMediaMtxCommand(config, configPath);

    // Then
    expect({ configYaml, command }).toEqual(buildMediaMtxPlan(config, configPath, apiUser));
  });
});
