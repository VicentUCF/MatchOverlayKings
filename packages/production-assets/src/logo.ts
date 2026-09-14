import type { ProductionAssetInput, ProductionAssetOptions } from './types.js';

export const SUPPORTED_LOGO_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export const MAX_LOGO_BYTES = 2_097_152;

export type LogoMediaType = (typeof SUPPORTED_LOGO_MEDIA_TYPES)[number];

class UnexpectedLogoKindError extends Error {
  public constructor() {
    super('Unexpected logo kind');
    this.name = 'UnexpectedLogoKindError';
  }
}

class InvalidLocalLogoError extends Error {
  public constructor() {
    super('Local logo bytes must match the reference media type and size limit');
    this.name = 'InvalidLocalLogoError';
  }
}

export function detectLogoMediaType(bytes: Uint8Array): LogoMediaType | undefined {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return undefined;
}

export function logoDataUri(
  team: ProductionAssetInput['home'],
  options: ProductionAssetOptions,
): string | undefined {
  const logo = team.logo;
  if (logo === undefined) {
    return undefined;
  }

  const bytes = (() => {
    switch (logo.kind) {
      case 'bytes':
        return logo.bytes;
      case 'local-ref':
        return options.localAssets?.[logo.ref];
      default:
        return assertNever(logo);
    }
  })();
  if (bytes === undefined) {
    return undefined;
  }

  const mediaType = logo.kind === 'local-ref'
    ? validateLocalLogoBytes(logo.ref, bytes)
    : detectLogoMediaType(bytes);
  if (mediaType === undefined) return undefined;

  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function validateLocalLogoBytes(ref: string, bytes: Uint8Array): LogoMediaType {
  const mediaType = detectLogoMediaType(bytes);
  if (bytes.byteLength > MAX_LOGO_BYTES || mediaType !== mediaTypeForRef(ref)) {
    throw new InvalidLocalLogoError();
  }
  return mediaType;
}

function mediaTypeForRef(ref: string): LogoMediaType {
  const extension = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      throw new InvalidLocalLogoError();
  }
}

function assertNever(value: never): never {
  void value;
  throw new UnexpectedLogoKindError();
}
