import { z } from 'zod';
import { detectLogoMediaType, MAX_LOGO_BYTES, SUPPORTED_LOGO_MEDIA_TYPES } from './logo.js';

const safeText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).refine(isXmlText, 'Text contains invalid XML characters');

const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase());
const LocalLogoRefSchema = z
  .string()
  .regex(/^\/logos\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:png|jpe?g|webp)$/i)
  .refine((value) => !value.split('/').includes('..'), 'Logo reference cannot traverse directories');

const LogoBytesSchema = z
  .strictObject({
    kind: z.literal('bytes'),
    mediaType: z.enum(SUPPORTED_LOGO_MEDIA_TYPES),
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= MAX_LOGO_BYTES),
  })
  .refine(
    (logo) => detectLogoMediaType(logo.bytes) === logo.mediaType,
    'Logo bytes must match the declared media type',
  )
  .readonly();

const LocalLogoSchema = z
  .strictObject({ kind: z.literal('local-ref'), ref: LocalLogoRefSchema })
  .readonly();

const TeamSchema = z
  .strictObject({
    name: safeText(80),
    shortName: safeText(32).optional(),
    color: ColorSchema.optional(),
    logo: z.union([LogoBytesSchema, LocalLogoSchema]).optional(),
  })
  .readonly();

export const ProductionAssetInputSchema = z
  .strictObject({
    leagueName: safeText(100),
    seasonLabel: safeText(32),
    matchdayLabel: safeText(32),
    matchdayNumber: z.number().int().positive().max(999),
    courtName: safeText(80),
    home: TeamSchema,
    away: TeamSchema,
    scheduledAt: z.iso.datetime({ offset: true }),
    timeZone: z.string().trim().max(80).refine(isTimeZone, 'Unsupported timezone'),
    locale: z.string().trim().max(35).refine(isLocale, 'Invalid locale'),
    publicUrl: z.url({ protocol: /^https$/ }).max(2_048).refine((value) => {
      const url = new URL(value);
      return url.username === '' && url.password === '';
    }, 'Public URL cannot contain credentials'),
    templateRevision: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/).max(48),
  })
  .readonly();

export function parseProductionAssetInput(input: unknown) {
  return ProductionAssetInputSchema.parse(input);
}

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function isXmlText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      return false;
    }
  }
  return true;
}
