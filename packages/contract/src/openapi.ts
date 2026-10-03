import { z } from 'zod';
import { API_BASE_PATH, problem, jsonSchema } from './schemas/common.js';
import { API_VERSION } from './version.js';
import * as work from './schemas/work.js';
import * as catalog from './schemas/catalog.js';
import * as platform from './schemas/platform.js';
import { ROUTES, type RouteDef } from './routes.js';

type Json = Record<string, unknown>;

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Domain schemas that get a stable, human-friendly component name. */
const NAMED: Record<string, z.ZodType> = {
  Problem: problem,
  Object: jsonSchema,
  Run: work.run,
  CreateRun: work.createRun,
  Phase: work.phase,
  Step: work.step,
  Finding: work.finding,
  Decision: work.decision,
  ResolveDecision: work.resolveDecision,
  Artifact: work.artifact,
  RunCost: work.runCost,
  ActivityItem: work.activityItem,
  Pack: catalog.pack,
  PackPreview: catalog.packPreview,
  InstallPack: catalog.installPack,
  AgentDefinition: catalog.agentDefinition,
  Agent: catalog.agent,
  Skill: catalog.skill,
  MemoryRecord: platform.memoryRecord,
  MemoryScope: platform.memoryScope,
  Project: platform.project,
  Schedule: platform.schedule,
  Operation: platform.operation,
  AuditEntry: platform.auditEntry,
  Capabilities: platform.capabilities,
  EventEnvelope: platform.eventEnvelope,
  Me: platform.me,
};

const pathParams = (path: string): string[] => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

const queryParameters = (query: z.ZodObject): Json[] => {
  const js = z.toJSONSchema(query, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(js.properties ?? {}).map(([name, schema]) => ({
    name,
    in: 'query',
    required: js.required?.includes(name) ?? false,
    schema,
  }));
};

const relax = (node: unknown): void => {
  if (Array.isArray(node)) return node.forEach(relax);
  if (node && typeof node === 'object') {
    const o = node as Json;
    delete o.$schema;
    delete o.$id;
    if (o.additionalProperties === false) delete o.additionalProperties;
    Object.values(o).forEach(relax);
  }
};

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
    license: { name: string; identifier: string };
  };
  servers: { url: string }[];
  security: Record<string, string[]>[];
  tags: { name: string }[];
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; securitySchemes: Json; responses: Json };
}

/** Builds the OpenAPI 3.1 document from the route table and the zod schemas. */
export function buildOpenApi(version = '0.0.0'): OpenApiDocument {
  const reg = z.registry<{ id: string }>();
  const names = new Map<z.ZodType, string>();
  const name = (schema: z.ZodType, fallback: string): string => {
    let n = names.get(schema);
    if (!n) {
      n = fallback;
      names.set(schema, n);
      reg.add(schema, { id: n });
    }
    return n;
  };
  for (const [n, schema] of Object.entries(NAMED)) name(schema, n);

  const refOf = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  const paths: OpenApiDocument['paths'] = {};
  const tags = new Set<string>();

  for (const r of ROUTES as readonly RouteDef[]) {
    tags.add(r.tag);
    const parameters: Json[] = pathParams(r.path).map((p) => ({
      name: p,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (r.query) parameters.push(...queryParameters(r.query));
    if (r.idempotent)
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      });
    if (r.ifMatch)
      parameters.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });

    const status = String(r.status ?? 200);
    const responses: Record<string, Json> = {
      default: {
        description: 'Error',
        content: { 'application/problem+json': { schema: PROBLEM_REF } },
      },
    };
    if (r.stream) {
      responses[status] = {
        description: 'Event stream (SSE) or a replay page',
        content: {
          'text/event-stream': { schema: { type: 'string' } },
          ...(r.response
            ? {
                'application/json': {
                  schema: refOf(name(r.response, `${cap(r.operationId)}Response`)),
                },
              }
            : {}),
        },
      };
    } else if (r.status === 204) {
      responses[status] = { description: 'No content' };
    } else if (r.response) {
      responses[status] = {
        description: 'Success',
        content: {
          'application/json': { schema: refOf(name(r.response, `${cap(r.operationId)}Response`)) },
        },
      };
    } else {
      responses[status] = {
        description: 'Success (binary or text body)',
        content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
      };
    }

    const op: Json = {
      operationId: r.operationId,
      summary: r.summary,
      tags: [r.tag],
      'x-permission': r.perm,
      'x-cut1': r.cut1,
      parameters,
      responses,
    };
    if (r.body) {
      op.requestBody = {
        required: true,
        content: {
          'application/json': { schema: refOf(name(r.body, `${cap(r.operationId)}Request`)) },
        },
      };
    }
    if (r.perm === 'public') op.security = [];

    const key = r.path;
    (paths[key] ??= {})[r.method.toLowerCase()] = op;
  }

  const { schemas } = z.toJSONSchema(reg, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as unknown as { schemas: Record<string, Json> };

  // v1 is additive: responses may grow fields, so do not forbid unknown properties.
  for (const schema of Object.values(schemas)) relax(schema);

  return {
    openapi: '3.1.0',
    info: {
      title: 'Krama API',
      version,
      description: `Krama platform API (${API_VERSION}). Generated from @kramahq/contract.`,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: API_BASE_PATH }],
    security: [{ bearer: [] }],
    tags: [...tags].map((t) => ({ name: t })),
    paths,
    components: {
      schemas,
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      responses: {},
    },
  };
}
