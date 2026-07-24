import { startServer } from './server.ts';

const { port } = await startServer();
// eslint-disable-next-line no-console
console.log(`agent-connectors MCP listening on http://0.0.0.0:${port}/mcp`);
