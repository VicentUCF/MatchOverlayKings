# Production Assets Manifest

## Usage

```ts
import { createProductionAssets } from '@kpl/production-assets';

const assets = createProductionAssets(untrustedMetadata, {
  localAssets: { '/logos/home.png': homeLogoBytes },
});
```

`createProductionAssets` parses the metadata boundary, performs no network or filesystem access, and returns the YouTube title, factual description, SVG, PNG bytes, storage key, template revision, and SHA-256 generation hash. A `local-ref` is rendered only when its bytes are supplied by the caller; otherwise the deterministic initials fallback is used.

## Manifest

| Identifier | Purpose | Source / generation record | Rights status | Format and size | Variants | Token dependencies | Accessible use | Destination / owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kpl-livestream-thumbnail` | YouTube livestream thumbnail | Deterministic SVG template in `src/thumbnail.ts`, rasterized locally with pinned `@resvg/resvg-js@2.6.2` | Project-authored template; `@resvg/resvg-js` declares MPL-2.0 in its installed package manifest | SVG and PNG, 1280x720 | Team colors, optional embedded/local caller logo bytes, initials fallback | Template palette and geometry in `src/tokens.ts`; validated caller team colors | Use the returned title as the image alternative when the thumbnail is informative; use empty alt when adjacent title text is equivalent | `livestream-thumbnails/...`; production preview and local agent consumers |
| `space-grotesk-bold` | Thumbnail display text | Pinned `@expo-google-fonts/space-grotesk@0.4.1` package | Installed package manifest declares `MIT AND OFL-1.1` | Local 700-weight TTF loaded from the installed package | Bold | `typography.heading` | Text remains live in SVG and is rasterized into PNG | Package runtime dependency |
| `manrope-bold` | Thumbnail metadata text | Pinned `@expo-google-fonts/manrope@0.4.1` package | Installed package manifest declares `MIT AND OFL-1.1` | Local 700-weight TTF loaded from the installed package | Bold | `typography.body` | Text remains live in SVG and is rasterized into PNG | Package runtime dependency |

## Provenance Boundaries

- The template palette is defined in this package and does not copy colors from repository logo files. Team colors are parsed from caller metadata and become part of the generated content hash.
- Repository logo files are not embedded or copied by this package because their rights metadata is not present in this repository.
- Caller-supplied logo bytes remain the caller's rights responsibility. Only PNG, JPEG, and WebP bytes up to 2 MiB are accepted; local references must resolve to bytes matching their extension. SVG logos and remote URLs are rejected.
- The SHA-256 covers the generated title, description, key, template revision, SVG, and PNG bytes. It changes for material metadata, template, color, or resolved-logo changes and is independent of ambient system fonts.
