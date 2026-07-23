export {
  MemoryService,
  MemoryNotFoundError,
  MemoryValidationError,
  memoryToPayload,
  payloadToMemory,
  type MemoryServiceDeps,
} from './service.js';
export {
  DECAY_RETRIEVED_FLOOR,
  DEFAULT_DECAY_WEIGHT,
  DEFAULT_HARD_DELETE_GRACE_DAYS,
  DEDUP_DEFAULT_THRESHOLD,
  DEDUP_MIN_THRESHOLD,
  DEDUP_DISABLED_THRESHOLD,
  MEMORY_KIND,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_METADATA_BYTES,
  MEMORY_MAX_SOURCE_LENGTH,
  MEMORY_MAX_SUMMARY_LENGTH,
  MEMORY_MAX_TAG_LENGTH,
  MEMORY_MAX_TAGS,
  RETENTION_HALF_LIFE_DAYS,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type MemoryKind,
  type MemoryRecord,
  type RestoreMemoryInput,
  type SearchMemoryInput,
  type SearchResult,
  type StoreMemoryInput,
  type StoreOutcome,
  type StoreResult,
  type UpdateMemoryMetadataInput,
} from './types.js';
export { ReinforcementBuffer, type ReinforcementBufferDeps } from './reinforcement.js';
export { DecaySweeper, DECAY_SWEEP_INTERVAL_MS, type DecaySweepStats } from '../lifecycle/decay.js';
export { registerMemoryTools, type MemoryToolDeps } from './tools.js';
