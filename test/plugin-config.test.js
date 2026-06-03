import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import Plugin, { __resetSharedManagerForTests } from '../src/index.js';

const REMOTE_MCP_URL =
  'https://e976ff2b-0c09-4c79-8d4d-24ab37440e28-mcp-server.ai-agent.inference.cloud.ru/mcp';

afterEach(() => {
  __resetSharedManagerForTests();
});

function createMockApi(handlers = {}) {
  const logs = [];
  const api = {
    logger: {
      info: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    pluginConfig: handlers.pluginConfig ?? {
      enabled: true,
      servers: {
        'mcp-e976ff2b': {
          enabled: true,
          transport: 'http',
          url: REMOTE_MCP_URL,
        },
      },
    },
    config: {
      plugins: {
        entries: {},
      },
    },
    registerService: (service) => {
      handlers.onService?.(service);
    },
    registerTool: (tool) => {
      handlers.onTool?.(tool);
    },
  };

  Plugin(api);
  return { api, logs, handlers };
}

test('tool execute reuses MCP connections from service start across register calls', async () => {
  let serviceStart;
  let toolExecute;

  createMockApi({
    onService: (service) => {
      serviceStart = service.start;
    },
    onTool: () => {},
  });

  await serviceStart({ config: { plugins: { entries: {} } } });

  createMockApi({
    onService: () => {},
    onTool: (tool) => {
      toolExecute = tool.execute;
    },
  });

  assert.ok(toolExecute, 'tool.execute should be registered');

  const result = await toolExecute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.doesNotMatch(text, /No MCP tools available\./);
  const tools = JSON.parse(text);
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 0);
  assert.equal(tools[0].server, 'mcp-e976ff2b');
});

test('uses api.pluginConfig when plugins.entries config is absent', async () => {
  let serviceStart;
  let toolExecute;

  createMockApi({
    pluginConfig: {
      enabled: true,
      servers: {
        'mcp-e976ff2b': {
          enabled: true,
          transport: 'http',
          url: 'https://127.0.0.1:1/mcp',
        },
      },
    },
    onService: (service) => {
      serviceStart = service.start;
    },
    onTool: (tool) => {
      toolExecute = tool.execute;
    },
  });

  await serviceStart({ config: { plugins: { entries: {} } } });

  const result = await toolExecute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.match(text, /No MCP tools available\./);
  assert.match(text, /Connection errors:/);
  assert.match(text, /mcp-e976ff2b:/);
});

test('reports missing servers when plugin config is empty', async () => {
  let toolExecute;

  createMockApi({
    pluginConfig: { enabled: true, servers: {} },
    onTool: (tool) => {
      toolExecute = tool.execute;
    },
  });

  const result = await toolExecute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.match(text, /No MCP servers found in plugin config\./);
});
