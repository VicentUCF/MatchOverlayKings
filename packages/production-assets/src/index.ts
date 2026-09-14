import { createHash } from 'node:crypto';
import { buildPublicationMetadata } from './metadata.js';
import { parseProductionAssetInput } from './schema.js';
import { buildThumbnailSvg, renderThumbnailPng } from './thumbnail.js';
import type { ProductionAssetOptions, ProductionAssets } from './types.js';

export { ProductionAssetInputSchema, parseProductionAssetInput } from './schema.js';
export { THUMBNAIL_TOKENS } from './tokens.js';
export type { ProductionAssetInput, ProductionAssetOptions, ProductionAssets } from './types.js';

export function createProductionAssets(
  rawInput: unknown,
  options: ProductionAssetOptions = {},
): ProductionAssets {
  const input = parseProductionAssetInput(rawInput);
  const metadata = buildPublicationMetadata(input);
  const svg = buildThumbnailSvg(input, options);
  const pngBytes = renderThumbnailPng(svg);
  const sha256 = createHash('sha256')
    .update(metadata.title)
    .update('\0')
    .update(metadata.description)
    .update('\0')
    .update(metadata.storageKey)
    .update('\0')
    .update(input.templateRevision)
    .update('\0')
    .update(svg)
    .update('\0')
    .update(pngBytes)
    .digest('hex');

  return {
    ...metadata,
    svg,
    pngBytes,
    templateRevision: input.templateRevision,
    sha256,
  };
}
