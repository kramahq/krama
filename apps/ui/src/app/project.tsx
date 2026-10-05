import type { Project } from '@kramahq/contract';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useCapabilities, useProjects } from '@/api/queries';

export const ALL_PROJECTS = 'all';
const KEY = 'krama.project';

interface ProjectState {
  /** `all` or a project id. */
  selected: string;
  project: Project | undefined;
  projects: Project[];
  select(id: string): void;
  /** False when the server is single-project: there is nothing to switch. */
  enabled: boolean;
}

const Ctx = createContext<ProjectState | null>(null);

export function useProject(): ProjectState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject needs a <ProjectProvider>');
  return v;
}

/** The project everything is scoped to: runs, inbox, memory and budget follow it. */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const list = useProjects();
  const [selected, setSelected] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) ?? ALL_PROJECTS;
    } catch {
      return ALL_PROJECTS;
    }
  });
  const projects = useMemo(() => list.data?.items ?? [], [list.data]);
  const enabled = caps.data?.features.multiProject ?? true;

  const select = useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* not persisted */
    }
  }, []);

  const value = useMemo<ProjectState>(() => {
    // A remembered project that no longer exists falls back to all projects instead of showing an empty app.
    const known = projects.some((p) => p.id === selected);
    const effective = !enabled || (projects.length > 0 && !known) ? ALL_PROJECTS : selected;
    return {
      selected: effective,
      project: projects.find((p) => p.id === effective),
      projects,
      select,
      enabled,
    };
  }, [projects, selected, select, enabled]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
