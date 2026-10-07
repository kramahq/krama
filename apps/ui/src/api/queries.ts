import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRun, ResolveDecision } from '@kramahq/contract';
import type { DecisionQuery, RunQuery } from '@kramahq/sdk';
import { api } from './client';

/** One place for query keys, so the live layer can invalidate exactly what an event touches. */
export const keys = {
  capabilities: ['capabilities'] as const,
  me: ['me'] as const,
  projects: ['projects'] as const,
  runs: (q?: RunQuery) => ['runs', q ?? {}] as const,
  run: (id: string) => ['run', id] as const,
  decisions: (q?: DecisionQuery) => ['decisions', q ?? {}] as const,
  runDecisions: (id: string) => ['run-decisions', id] as const,
  packs: ['packs'] as const,
  pack: (id: string) => ['pack', id] as const,
  activity: (runId: string) => ['activity', runId] as const,
};

// Things that rarely change are cached for a long time; work state is kept fresh by the live event stream.
export const useCapabilities = () =>
  useQuery({
    queryKey: keys.capabilities,
    queryFn: () => api.capabilities(),
    staleTime: 5 * 60_000,
  });
export const useAllowedBackends = () =>
  useQuery({
    queryKey: ['allowed-backends'],
    queryFn: () => api.allowedBackends(),
    staleTime: 60_000,
  });
export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 5 * 60_000 });
export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: () => api.projects.list(), staleTime: 60_000 });
export const usePacks = () =>
  useQuery({ queryKey: keys.packs, queryFn: () => api.packs.list(), staleTime: 60_000 });
export const usePack = (id: string | undefined) =>
  useQuery({
    queryKey: keys.pack(id ?? ''),
    queryFn: () => api.packs.get(id!),
    enabled: !!id,
    staleTime: 60_000,
  });

export const useRuns = (q?: RunQuery) =>
  useQuery({
    queryKey: keys.runs(q),
    queryFn: ({ signal }) => api.runs.list({ limit: 100, ...q }, signal),
    placeholderData: keepPreviousData,
  });
export const useRun = (id: string) =>
  useQuery({ queryKey: keys.run(id), queryFn: () => api.runs.get(id, ['phases']) });

export const useDecisions = (q?: DecisionQuery) =>
  useQuery({
    queryKey: keys.decisions(q),
    queryFn: ({ signal }) => api.decisions.list({ limit: 100, ...q }, signal),
    placeholderData: keepPreviousData,
  });
export const useRunDecisions = (id: string) =>
  useQuery({
    queryKey: keys.runDecisions(id),
    queryFn: () => api.runs.decisions(id, { status: 'pending' }),
  });

export function useResolveDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ResolveDecision }) =>
      api.decisions.resolve(id, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['decisions'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run'] });
    },
  });
}

export function useRunAction(action: 'pause' | 'resume' | 'stop') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runs[action](id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run'] });
    },
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRun) => api.runs.create(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  });
}
