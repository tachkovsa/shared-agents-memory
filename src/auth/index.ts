export * from './types.js';
export {
  generateToken,
  parseToken,
  hashSecret,
  safeEqualHex,
  TOKEN_NAMESPACE,
  TOKEN_SECRET_LENGTH,
  TOKEN_PREFIX_LENGTH,
} from './hash.js';
export {
  loadOrInitPepper,
  PepperMismatchError,
  PEPPER_BYTES,
  PEPPER_ENV_VAR,
} from './pepper.js';
export {
  PatStore,
  PatNotFoundError,
  DEFAULT_CACHE_TTL_MS,
} from './pat-store.js';
export {
  runBootstrapIfNeeded,
  deriveBootstrapPaths,
  stderrLogger,
  BootstrapStateError,
} from './bootstrap.js';
export type {
  BootstrapLogger,
  BootstrapPaths,
  BootstrapResult,
  RunBootstrapOptions,
} from './bootstrap.js';
export {
  AuthError,
  type AuthFailureReason,
  type RequestContext,
} from './request-context.js';
export {
  resolvePat,
  resolveRequest,
  authorizeNamespaceAccess,
  type ResolveRequestOptions,
  type AuthorizeOptions,
} from './resolve-request.js';
export {
  AuthAuditWriter,
  auditPathForDataDir,
  resolveSampleRate,
  DEFAULT_SUCCESS_SAMPLE_RATE,
  SAMPLE_RATE_ENV_VAR,
  type AuthAuditEvent,
  type AuditLine,
  type AuditWriterOptions,
} from './audit.js';
