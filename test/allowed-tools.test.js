import assert from 'node:assert/strict';
import test, { after, afterEach, before } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Plugin, { __resetSharedManagerForTests } from '../src/index.js';

const TEST_SERVER_PORT = 3005;
const TEST_SERVER_URL = `http://127.0.0.1:${TEST_SERVER_PORT}/mcp`;

let serverProcess;

before(() => {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    serverProcess = spawn('node', [path.join(dir, 'test-server.js')], {
      stdio: 'pipe',
    });
    serverProcess.on('error', reject);
    setTimeout(resolve, 500);
  });
});

after(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

afterEach(() => {
  __resetSharedManagerForTests();
});

async function startAndGetExecutor(serverConfig) {
  let serviceStart;
  let toolExecute;

  Plugin({
    logger: { info: () => {}, error: () => {} },
    pluginConfig: { enabled: true, servers: { test: serverConfig } },
    config: { plugins: { entries: {} } },
    registerService: (service) => {
      serviceStart = service.start;
    },
    registerTool: (tool) => {
      toolExecute = tool.execute;
    },
  });

  await serviceStart({ config: { plugins: { entries: {} } } });
  assert.ok(toolExecute, 'tool.execute should be registered');
  return toolExecute;
}

function baseServerConfig(allowedTools) {
  const config = {
    enabled: true,
    transport: 'http',
    url: TEST_SERVER_URL,
  };
  if (allowedTools !== undefined) {
    config.allowed_tools = allowedTools;
  }
  return config;
}

test('empty allowed_tools exposes no tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig([]));
  const result = await execute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.doesNotMatch(text, /"name": "echo"/);
  assert.doesNotMatch(text, /"name": "add"/);
});

test('missing allowed_tools exposes no tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig(undefined));
  const result = await execute('test-id', { action: 'list' });
  const text = result.content[0].text;

  assert.doesNotMatch(text, /"name": "echo"/);
  assert.doesNotMatch(text, /"name": "add"/);
});

test('allowed_tools whitelist exposes only listed tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig(['echo']));
  const result = await execute('test-id', { action: 'list' });
  const tools = JSON.parse(result.content[0].text);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
});

test('full allowed_tools whitelist exposes all server tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig(['echo', 'add']));
  const result = await execute('test-id', { action: 'list' });
  const tools = JSON.parse(result.content[0].text);

  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'echo']);
});

test('call rejects tool outside allowed_tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig(['echo']));
  const result = await execute('test-id', {
    action: 'call',
    server: 'test',
    tool: 'add',
    args: { a: 1, b: 2 },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Tool not allowed: add/);
  assert.match(result.content[0].text, /allowed_tools/);
});

test('call allows tool inside allowed_tools', async () => {
  const execute = await startAndGetExecutor(baseServerConfig(['echo']));
  const result = await execute('test-id', {
    action: 'call',
    server: 'test',
    tool: 'echo',
    args: { message: 'hi' },
  });

  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.content[0].text, /Echo: hi/);
});
