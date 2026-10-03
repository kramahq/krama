import { buildMock } from './app.js';

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? '127.0.0.1';
const { app } = await buildMock();
await app.listen({ port, host });
console.log(`Krama mock API on http://${host}:${port}/api/v1  (control: /__mock/*)`);
