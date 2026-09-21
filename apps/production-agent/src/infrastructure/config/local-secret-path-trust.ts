const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY_BIT = 0o1000;

export type PosixPathMetadata = {
  readonly mode: number;
  readonly uid: number;
};

export function isTrustedAncestor(
  metadata: PosixPathMetadata,
  effectiveUserId: number,
): boolean {
  const isRootOwned = metadata.uid === 0;
  const isEffectiveUserOwned = metadata.uid === effectiveUserId;
  if (!isRootOwned && !isEffectiveUserOwned) return false;
  const isWritable = (metadata.mode & GROUP_OR_OTHER_WRITE) !== 0;
  const isSticky = (metadata.mode & STICKY_BIT) !== 0;
  return !isWritable || isSticky;
}
