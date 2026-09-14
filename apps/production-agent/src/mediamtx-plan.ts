import { isAbsolute } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { LocalMediaRuntimeConfig } from './media-runtime-config.js';
import {
  MEDIA_PROCESS_ENV,
  type ProcessCommandPlan,
  type ProcessStdioPlan,
} from './process-command-plan.js';

const MediaMtxPathSchema = z.strictObject({
  source: z.literal('publisher'),
  overridePublisher: z.literal(false),
});
const LoopbackIpsSchema = z.tuple([z.literal('127.0.0.1'), z.literal('::1')]);
const MediaMtxApiUserSchema = z.strictObject({
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).refine((username) => username !== 'any'),
  passwordHash: z.string().regex(/^sha256:[A-Za-z0-9+/]{43}=$/),
}).readonly();
const MediaMtxApiPermissionSchema = z.strictObject({ action: z.literal('api') });
const MediaMtxPublishPermissionSchema = z.strictObject({
  action: z.literal('publish'),
  path: z.string(),
});
const MediaMtxApiAuthUserSchema = z.strictObject({
  user: z.string(),
  pass: z.string(),
  ips: LoopbackIpsSchema,
  permissions: z.tuple([MediaMtxApiPermissionSchema]),
});
const MediaMtxSrtPublisherAuthUserSchema = z.strictObject({
  user: z.literal('any'),
  ips: LoopbackIpsSchema,
  permissions: MediaMtxPublishPermissionSchema.array().length(4),
});
const MediaMtxConfigSchema = z.strictObject({
  logDestinations: z.tuple([z.literal('stdout')]),
  logStructured: z.literal(true),
  api: z.literal(true),
  apiAddress: z.string(),
  apiEncryption: z.literal(false),
  rtsp: z.literal(false),
  rtmp: z.literal(false),
  hls: z.literal(false),
  webrtc: z.literal(false),
  moq: z.literal(false),
  srt: z.literal(true),
  srtAddress: z.string(),
  authMethod: z.literal('internal'),
  authInternalUsers: z.tuple([MediaMtxApiAuthUserSchema, MediaMtxSrtPublisherAuthUserSchema]),
  paths: z.record(z.string(), MediaMtxPathSchema),
});

export type MediaMtxPlan = {
  readonly command: ProcessCommandPlan;
  readonly configYaml: string;
};

export function buildMediaMtxPlan(
  config: LocalMediaRuntimeConfig,
  configPath: string,
  apiUserInput: unknown,
): MediaMtxPlan {
  return Object.freeze({
    command: buildMediaMtxCommand(config, configPath),
    configYaml: buildMediaMtxConfigYaml(config, apiUserInput),
  });
}

export function buildMediaMtxConfigYaml(
  config: LocalMediaRuntimeConfig,
  apiUserInput: unknown,
): string {
  const apiUser = MediaMtxApiUserSchema.parse(apiUserInput);
  const permissions = config.bindings.courts
    .map(({ pathName }) => ({ action: 'publish', path: pathName }));
  const document = MediaMtxConfigSchema.parse({
    logDestinations: ['stdout'],
    logStructured: true,
    api: true,
    apiAddress: `${config.bindings.apiHost}:${config.bindings.apiPort}`,
    apiEncryption: false,
    rtsp: false,
    rtmp: false,
    hls: false,
    webrtc: false,
    moq: false,
    srt: true,
    srtAddress: `${config.bindings.srtHost}:${config.bindings.srtPort}`,
    authMethod: 'internal',
    authInternalUsers: [{
      user: apiUser.username,
      pass: apiUser.passwordHash,
      ips: ['127.0.0.1', '::1'],
      permissions: [{ action: 'api' }],
    }, {
      user: 'any',
      ips: ['127.0.0.1', '::1'],
      permissions,
    }],
    paths: Object.fromEntries(config.bindings.courts.map(({ pathName }) => [
      pathName,
      { source: 'publisher', overridePublisher: false },
    ])),
  });
  return stringify(document, { lineWidth: 0, sortMapEntries: true });
}

export function buildMediaMtxCommand(
  config: LocalMediaRuntimeConfig,
  configPath: string,
): ProcessCommandPlan {
  if (!isAbsolute(configPath)) throw new TypeError('MediaMTX config path must be absolute');
  const stdio: readonly ProcessStdioPlan[] = Object.freeze(['ignore', 'pipe', 'pipe']);
  return Object.freeze({
    executable: config.mediaMtxExecutablePath,
    argv: Object.freeze([configPath]),
    cwd: config.runtimeDirectoryPath,
    env: MEDIA_PROCESS_ENV,
    stdio,
    shell: false,
  });
}
