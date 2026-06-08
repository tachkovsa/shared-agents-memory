import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useSetupStatus() {
  return useQuery({ queryKey: ['setup-status'], queryFn: () => api.setupStatus() });
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.login,
    onSuccess: (res) => qc.setQueryData(['me'], res),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.setup,
    onSuccess: (res) => qc.setQueryData(['me'], res),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.removeQueries({ queryKey: ['me'] });
    },
  });
}
