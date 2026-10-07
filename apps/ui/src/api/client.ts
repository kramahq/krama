import { createClient } from '@kramahq/sdk';

/** Where the API lives. Same origin by default: the dev server proxies `/api` to the mock or a real server. */
export const API_BASE: string = import.meta.env.VITE_KRAMA_API ?? '/api/v1';

function savedToken(): string | undefined {
  try {
    return localStorage.getItem('krama.token') ?? undefined;
  } catch {
    return undefined;
  }
}

export const api = createClient({ baseUrl: API_BASE, token: savedToken() });
