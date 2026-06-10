import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['namespaces'] }),
  });
}
export function useShareNamespace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agent_id: string; scopes: AgentScope[] }) => api.shareNamespace(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['namespace', id] }),
  });
}

// ── memory ──
export function useMemories(ns: string | null, includeDeleted = false) {
  return useQuery({
    queryKey: ['memories', ns, includeDeleted],
    queryFn: () => api.memories(ns as string, { include_deleted: includeDeleted, limit: 100 }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memories', ns] }),
  });
}
export function useWriteMemory(ns: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; agent_id: string; tags?: string[]; summary?: string; source?: string }) =>
      api.writeMemory(ns, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memories', ns] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}
export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.revokePat(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}
export function useRotatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rotatePat(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}

// ── rules ──
export function useRules(ns: string | null) {
  return useQuery({ queryKey: ['rules', ns], queryFn: () => api.rules(ns as string), enabled: !!ns });
}
export function useToggleRule(ns: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) => api.toggleRule(ns, ruleId, enabled),
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
