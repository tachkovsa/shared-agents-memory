export interface MemoryRecord {
  id: string;
  namespace: string;
  agentId: string;
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
