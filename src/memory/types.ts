export const MEMORY_KIND = 'episodic' as const;
export type MemoryKind = typeof MEMORY_KIND;

export interface MemoryRecord {
  id: string;
  namespace: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface SearchResult {
  memory: MemoryRecord;
  score: number;
}

export interface StoreMemoryInput {
  namespace: string;
  agentId: string;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  source?: string;
  id?: string;
}

export interface SearchMemoryInput {
  namespace: string;
  query: string;
  limit?: number;
  tags?: string[];
}

export interface GetMemoryInput {
  namespace: string;
  id: string;
}

export interface UpdateMemoryMetadataInput {
  namespace: string;
  id: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  source?: string;
}

export interface DeleteMemoryInput {
  namespace: string;
  id: string;
}

export const MEMORY_MAX_CONTENT_LENGTH = 32_000;
export const MEMORY_MAX_TAGS = 20;
