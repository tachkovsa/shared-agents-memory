import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentScope } from '@/lib/api';

// ── namespaces ──
export function useNamespaces() {
  return useQuery({ queryKey: ['namespaces'], queryFn: () => api.namespaces() });
}
export function useNamespace(id: string | null) {
  return useQuery({ queryKey: ['namespace', id], queryFn: () => api.namespace(id as string), enabled: !!id });
}
export function useCreateNamespace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; display_name: string; owner_agent_id: string }) => api.createNamespace(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespaces'] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}
export function useShareNamespace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agent_id: string; scopes: AgentScope[] }) => api.shareNamespace(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['namespace', id] }),
  });
}
export function useUnshareNamespace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.unshareNamespace(id, agentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['namespace', id] }),
  });
}

// ── memory ──
export function useMemories(ns: string | null, includeDeleted = false) {
  return useInfiniteQuery({
    queryKey: ['memories', ns, includeDeleted],
    queryFn: ({ pageParam }) =>
      api.memories(ns as string, { include_deleted: includeDeleted, limit: 100, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!ns,
  });
}
export function useMemory(ns: string | null, id: string | null) {
  return useQuery({
    queryKey: ['memory', ns, id],
    queryFn: () => api.memory(ns as string, id as string),
    enabled: !!ns && !!id,
  });
}
export function useDeleteMemory(ns: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(ns, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', ns] });
      qc.invalidateQueries({ queryKey: ['mem-search', ns] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}
export function useWriteMemory(ns: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; agent_id: string; tags?: string[]; summary?: string; source?: string }) =>
      api.writeMemory(ns, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', ns] });
      qc.invalidateQueries({ queryKey: ['mem-search', ns] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}

// ── PAT ──
export function usePats() {
  return useQuery({ queryKey: ['pats'], queryFn: () => api.pats() });
}
export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createPat,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pats'] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}
export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.revokePat(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pats'] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}
export function useRotatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rotatePat(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pats'] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}
export function useDeletePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePat(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pats'] });
      qc.invalidateQueries({ queryKey: ['observability'] });
    },
  });
}

// ── rules ──
export function useRules(ns: string | null) {
  return useQuery({ queryKey: ['rules', ns], queryFn: () => api.rules(ns as string), enabled: !!ns });
}
export function useCreateRule(ns: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rule_id: string; title: string; body: string; severity?: 'hard' | 'soft'; tags?: string[] }) =>
      api.createRule(ns, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', ns] }),
  });
}

// ── audit ──
export function useAudit(event?: string) {
  return useQuery({ queryKey: ['audit', event], queryFn: () => api.audit({ limit: 200, event }) });
}

// ── observability ──
export function useObservability() {
  return useQuery({ queryKey: ['observability'], queryFn: () => api.observability() });
}

// ── billing ──
export function useBilling() {
  return useQuery({ queryKey: ['billing'], queryFn: () => api.billing() });
}
