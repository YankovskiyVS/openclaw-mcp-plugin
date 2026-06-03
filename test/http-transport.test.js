import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamableHTTPClientTransport } from '../src/http-transport.js';

const REMOTE_MCP_URL =
  'https://e976ff2b-0c09-4c79-8d4d-24ab37440e28-mcp-server.ai-agent.inference.cloud.ru/mcp';

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()];
}

test('POST requests include MCP Accept header', async () => {
  const seenHeaders = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    seenHeaders.push(init?.headers);
    return originalFetch(url, init);
  };

  try {
    const transport = new StreamableHTTPClientTransport(REMOTE_MCP_URL, {
      headers: {
        'X-Test-Header': 'openclaw-mcp-plugin',
      },
    });

    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'accept-header-test', version: '0.1.0' },
      },
    });
    await transport.close();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const postHeaders = seenHeaders.find((headers) => {
    const accept = getHeader(headers, 'Accept');
    return accept === 'application/json, text/event-stream';
  });

  assert.ok(postHeaders, 'expected POST with MCP Accept header');
  assert.equal(getHeader(postHeaders, 'X-Test-Header'), 'openclaw-mcp-plugin');
});

test('connects to remote MCP server and lists tools', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const transport = new StreamableHTTPClientTransport(REMOTE_MCP_URL);
  const client = new Client(
    { name: 'openclaw-remote-test', version: '0.1.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  assert.ok(tools.length > 0, 'expected at least one tool from remote MCP server');
});
