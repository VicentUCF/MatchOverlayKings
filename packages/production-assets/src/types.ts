import type { z } from 'zod';
import type { ProductionAssetInputSchema } from './schema.js';

export type ProductionAssetInput = z.infer<typeof ProductionAssetInputSchema>;

export type ProductionAssetOptions = {
  readonly localAssets?: Readonly<Record<string, Uint8Array>>;
};

export type ProductionAssets = {
  readonly title: string;
  readonly description: string;
  readonly svg: string;
  readonly pngBytes: Uint8Array;
  readonly storageKey: string;
  readonly templateRevision: string;
  readonly sha256: string;
};
