import type { FastifyInstance } from 'fastify';
import { buildApi } from './api/app.js';
import { loadConfig, type ConfigInput, type ServerConfig } from './api/config.js';
import { createKrama, type Krama, type KramaOptions } from './compose.js';

export interface RunningServer {
  url: string;
  config: ServerConfig;
  krama: Krama;
  app: FastifyInstance;
  /** Stops accepting requests, then agents and the database. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Composes Krama, puts the HTTP API in front of it and starts listening. Packs and agent definitions come from the
 * caller until the pack loader exists (M6.1).
 */
export async function serve(
  input: ConfigInput & { krama?: Partial<Pick<KramaOptions, 'packs' | 'definitions'>> } = {},
): Promise<RunningServer> {
  const config = loadConfig(input);
  const krama = await createKrama({
    home: config.home,
    packs: input.krama?.packs ?? [],
    definitions: input.krama?.definitions ?? [],
    policy: config.policy.engine,
  });
  let app: FastifyInstance | undefined;
  try {
    app = await buildApi({ krama, config });
    const url = await app.listen({ host: config.host, port: config.port });
    let closed = false;
    const running = app;
    return {
      url,
      config,
      krama,
      app: running,
      async close() {
        if (closed) return;
        closed = true;
        await running.close();
        await krama.close();
      },
    };
  } catch (e) {
    await app?.close().catch(() => undefined);
    await krama.close();
    throw e;
  }
}
