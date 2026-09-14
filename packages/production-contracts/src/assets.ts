import { z } from 'zod';
import {
  AssetSpecIdSchema,
  ClubIdSchema,
  JsonValueSchema,
  ProductionEventIdSchema,
} from './common.js';

export const AssetKindSchema = z.enum(['image', 'video', 'audio', 'font', 'template']);

export const AssetSpecSchema = z
  .strictObject({
    id: AssetSpecIdSchema,
    clubId: ClubIdSchema,
    eventId: ProductionEventIdSchema,
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(200),
    version: z.number().int().positive(),
    kind: AssetKindSchema,
    uri: z.string().regex(/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    metadata: JsonValueSchema,
  })
  .readonly();

export type AssetKind = z.infer<typeof AssetKindSchema>;
export type AssetSpec = z.infer<typeof AssetSpecSchema>;
