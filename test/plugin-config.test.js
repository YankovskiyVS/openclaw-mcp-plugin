import assert from 'node:assert/strict';
import test from 'node:test';
import Plugin from '../src/index.js';

function createMockApi(pluginConfig) {
  const logs = [];
  let serviceStart;
  let toolExecute;

  const mockApi = {
    logger: {
      info: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    pluginConfig,
    config: {
      plugins: {
        entries: {},
      },
    },
    registerService: (service) => {
      serviceStart = service.start;
    },
    registerTool: (tool) => {
      toolExecute = tool.execute;
    },
  };

  Plugin(mockApi);

  return {
    logs,
    start: serviceStart,
    execute: toolExecute,
  };
}

test('uses api.pluginConfig when plugins.entries config is absent', async () => {
  const mock = createMockApi({
    enabled: true,
    servers: {
      'mcp-e976ff2b': {
        enabled: true,
        transport: 'http',
        url: 'https://127.0.0.1:1/mcp',
      },
    },
  });

  assert.ok(mock.start, 'service.start should be registered');
  assert.ok(mock.execute, 'tool.execute should be registered');

  await mock.start({ config: { plugins: { entries: {} } } });

  const result = await mock.execute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.match(text, /No MCP tools available\./);
  assert.match(text, /Connection errors:/);
  assert.match(text, /mcp-e976ff2b:/);
});

test('reports missing servers when plugin config is empty', async () => {
  const mock = createMockApi({ enabled: true, servers: {} });

  await mock.start({ config: { plugins: { entries: {} } } });
  const result = await mock.execute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.match(text, /No MCP servers found in plugin config\./);
});
