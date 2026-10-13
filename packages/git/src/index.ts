export * from './git.js';
export * from './repo.js';
export { scanText, looksBinary, type SecretFinding } from './secrets.js';
export const PACKAGE_NAME = '@kramahq/git';
export {
  Sources,
  normalizeRemote,
  remoteAllowed,
  type LockEntry,
  type MovedTag,
  type RefKind,
  type SourceEvent,
  type SourceRef,
  type SourcesOptions,
} from './sources.js';
