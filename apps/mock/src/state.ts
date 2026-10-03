import type {
  ActivityItem,
  Agent,
  AgentDefinition,
  Artifact,
  AuditEntry,
  Capabilities,
  Decision,
  EventEnvelope,
  MemoryRecord,
  MemoryScope,
  Operation,
  Pack,
  Project,
  Run,
  Schedule,
  Step,
} from '@kramahq/contract';
import { fixture } from './fixtures.js';
import { definitions, packs } from './seed/packs.js';
import { agents, audit, memory, memoryScopes, projects, schedules } from './seed/platform.js';
import {
  activity,
  artifactContent,
  artifacts,
  decisions,
  findings,
  runs,
  steps,
  workspaceFiles,
} from './seed/runs.js';

export interface MockState {
  capabilities: Capabilities;
  packs: Pack[];
  definitions: AgentDefinition[];
  projects: Project[];
  runs: Run[];
  decisions: Decision[];
  artifacts: Artifact[];
  artifactContent: typeof artifactContent;
  steps: Step[];
  activity: ActivityItem[];
  findings: typeof findings;
  workspaceFiles: Record<string, string>;
  agents: Agent[];
  memory: MemoryRecord[];
  memoryScopes: MemoryScope[];
  schedules: Schedule[];
  audit: AuditEntry[];
  operations: Map<string, Operation>;
  events: EventEnvelope[];
  /** Next event cursor. */
  seq: number;
  /** Simulated outage: SSE stays silent when true. */
  streamPaused: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

export function createState(): MockState {
  return {
    capabilities: fixture<Capabilities>('capabilities.json'),
    packs: clone(packs),
    definitions: clone(definitions),
    projects: clone(projects),
    runs: clone(runs),
    decisions: clone(decisions),
    artifacts: clone(artifacts),
    artifactContent,
    steps: clone(steps),
    activity: clone(activity),
    findings: clone(findings),
    workspaceFiles,
    agents: clone(agents),
    memory: clone(memory),
    memoryScopes: clone(memoryScopes),
    schedules: clone(schedules),
    audit: clone(audit),
    operations: new Map(),
    events: [],
    seq: 1,
    streamPaused: false,
  };
}
