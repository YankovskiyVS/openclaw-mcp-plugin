import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from './http-transport.js';

const PLUGIN_ID = 'mcp-integration';

/** Shared across repeated plugin register() calls (active + tool-discovery registries). */
let sharedManager = null;

function getSharedManager(logger) {
  if (!sharedManager) {
    sharedManager = new MCPManager(logger);
  }
  return sharedManager;
}

function resolvePluginConfig(api, ctx) {
  const fromService = ctx?.config?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (fromService && typeof fromService === 'object' && !Array.isArray(fromService)) {
    return fromService;
  }

  if (api.pluginConfig && typeof api.pluginConfig === 'object' && !Array.isArray(api.pluginConfig)) {
    return api.pluginConfig;
  }

  const fromApi = api.config?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (fromApi && typeof fromApi === 'object' && !Array.isArray(fromApi)) {
    return fromApi;
  }

  return {};
}

function resolveAllowedTools(config) {
  const raw = config?.allowed_tools ?? config?.allowedTools;
  if (!Array.isArray(raw)) {
    return new Set();
  }
  return new Set(
    raw.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)
  );
}

function isToolAllowed(allowedSet, toolName) {
  return allowedSet.has(toolName);
}

function normalizeServerConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const allowedTools = config.allowed_tools ?? config.allowedTools;

  return {
    ...config,
    url: typeof config.url === 'string' ? config.url.trim() : config.url,
    allowed_tools: Array.isArray(allowedTools) ? allowedTools : [],
  };
}

function seedServerConfigs(manager, pluginConfig) {
  for (const [name, config] of Object.entries(pluginConfig.servers || {})) {
    manager.serverConfigs.set(name, normalizeServerConfig(config));
  }
}

function formatEmptyToolsMessage(status) {
  const lines = ['No MCP tools available.'];

  if (status.configured.length === 0) {
    lines.push('No MCP servers found in plugin config.');
    lines.push(`Expected config at plugins.entries.${PLUGIN_ID}.config.servers.`);
    return lines.join('\n');
  }

  if (Object.keys(status.errors).length > 0) {
    lines.push('Connection errors:');
    for (const [name, error] of Object.entries(status.errors)) {
      lines.push(`- ${name}: ${error}`);
    }
    return lines.join('\n');
  }

  lines.push('Configured servers did not expose any tools.');
  lines.push(`Configured: ${status.configured.join(', ')}`);
  if (status.connected.length > 0) {
    lines.push(`Connected: ${status.connected.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * MCP Integration Plugin for OpenClaw
 * Connects to MCP servers via Streamable HTTP transport
 */
class MCPManager {
  constructor(logger) {
    this.logger = logger;
    this.clients = new Map();
    this.tools = new Map();
    this.serverConfigs = new Map();
    this.connectionErrors = new Map();
  }

  async connectAll(servers = {}) {
    for (const [name, config] of Object.entries(servers)) {
      const normalized = normalizeServerConfig(config);
      this.serverConfigs.set(name, normalized);

      if (normalized.enabled === false || !normalized.url) {
        continue;
      }

      try {
        await this.connectServer(name, normalized);
      } catch (error) {
        this.logger.error(`[MCP] Failed to initialize ${name}: ${error.message}`);
      }
    }
  }

  async ensureReady() {
    await this.reconnectAll();

    if (this.tools.size > 0) {
      return;
    }

    for (const [name, config] of this.serverConfigs.entries()) {
      if (config.enabled === false || !config.url || this.clients.has(name)) {
        continue;
      }

      try {
        await this.connectServer(name, config);
      } catch {
        // Error already stored for status reporting.
      }
    }
  }

  async reconnectAll() {
    for (const [name, config] of this.serverConfigs.entries()) {
      if (config.enabled === false || !config.url || this.clients.has(name)) {
        continue;
      }

      try {
        await this.connectServer(name, config);
      } catch {
        // Error already stored for status reporting.
      }
    }
  }

  async connectServer(name, config) {
    const normalized = normalizeServerConfig(config);
    this.serverConfigs.set(name, normalized);

    const url = normalized.url;
    if (!url) {
      const message = 'Missing server URL';
      this.connectionErrors.set(name, message);
      throw new Error(message);
    }

    let safeUrl = url;
    try {
      const u = new URL(url);
      u.password = '';
      u.username = '';
      safeUrl = u.toString();
    } catch {
      // Keep original URL in logs if parsing fails.
    }

    await this.disconnectServer(name);
    this.logger.info(`[MCP] Connecting to ${name} at ${safeUrl}`);

    try {
      const transport = new StreamableHTTPClientTransport(url, {
        headers: normalized.headers,
        debug: normalized.debug === true,
      });

      const client = new Client(
        { name: `openclaw-${name}`, version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      const { tools } = await client.listTools();
      const allowedSet = resolveAllowedTools(normalized);
      const filtered = tools.filter((tool) => isToolAllowed(allowedSet, tool.name));

      this.clients.set(name, { client, transport });
      this.connectionErrors.delete(name);

      for (const tool of filtered) {
        this.tools.set(`${name}:${tool.name}`, {
          server: name,
          tool,
          client
        });
      }

      this.logger.info(
        `[MCP] Connected to ${name}: ${filtered.length}/${tools.length} tools available (${allowedSet.size} in allowed_tools)`
      );
      return filtered;
    } catch (error) {
      this.connectionErrors.set(name, error.message);
      this.logger.error(`[MCP] Failed to connect to ${name}: ${error.message}`);
      throw error;
    }
  }

  async callTool(serverName, toolName, args = {}) {
    await this.ensureReady();

    if (!this.clients.has(serverName)) {
      const config = this.serverConfigs.get(serverName);
      if (!config) {
        throw new Error(`Unknown MCP server: ${serverName}`);
      }
      await this.connectServer(serverName, config);
    }

    const toolKey = `${serverName}:${toolName}`;
    const entry = this.tools.get(toolKey);

    if (!entry) {
      const config = this.serverConfigs.get(serverName);
      const allowedSet = resolveAllowedTools(config);
      if (allowedSet.size > 0 && !isToolAllowed(allowedSet, toolName)) {
        throw new Error(
          `Tool not allowed: ${toolName} (not in allowed_tools for server ${serverName})`
        );
      }
      throw new Error(`Tool not found: ${toolKey}. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    const result = await entry.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  listTools() {
    const toolList = [];
    for (const [key, entry] of this.tools.entries()) {
      toolList.push({
        id: key,
        server: entry.server,
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema
      });
    }
    return toolList;
  }

  getStatus() {
    return {
      configured: [...this.serverConfigs.keys()],
      connected: [...this.clients.keys()],
      errors: Object.fromEntries(this.connectionErrors.entries()),
    };
  }

  async disconnectServer(name) {
    const entry = this.clients.get(name);
    if (entry) {
      try {
        await entry.client.close();
        this.logger.info(`[MCP] Disconnected from ${name}`);
      } catch (error) {
        this.logger.error(`[MCP] Error disconnecting from ${name}: ${error.message}`);
      }
    }

    this.clients.delete(name);

    for (const key of [...this.tools.keys()]) {
      if (key.startsWith(`${name}:`)) {
        this.tools.delete(key);
      }
    }
  }

  async disconnect() {
    for (const name of [...this.clients.keys()]) {
      await this.disconnectServer(name);
    }
    this.serverConfigs.clear();
    this.connectionErrors.clear();
  }
}

/**
 * OpenClaw plugin entry point
 */
export default function register(api) {
  const mcpManager = getSharedManager(api.logger);
  const pluginConfig = resolvePluginConfig(api, null);
  seedServerConfigs(mcpManager, pluginConfig);

  api.registerService({
    id: PLUGIN_ID,
    start: async (ctx) => {
      api.logger.info('[MCP] Starting...');

      const runtimeConfig = resolvePluginConfig(api, ctx);
      if (runtimeConfig.enabled === false) {
        api.logger.info('[MCP] Plugin disabled in config');
        return;
      }

      seedServerConfigs(mcpManager, runtimeConfig);
      await mcpManager.connectAll(runtimeConfig.servers || {});

      const status = mcpManager.getStatus();
      api.logger.info(
        `[MCP] Started (${status.connected.length} connected, ${status.configured.length} configured, ${Object.keys(status.errors).length} failed)`
      );
    },
    stop: async () => {
      api.logger.info('[MCP] Stopping...');
      await mcpManager.disconnect();
      sharedManager = null;
    }
  });

  api.registerTool({
    name: 'mcp',
    description: 'Call MCP (Model Context Protocol) server tools. Use action=list to see available tools, then action=call to invoke them.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'call'],
          description: 'Action: list or call'
        },
        server: {
          type: 'string',
          description: 'MCP server name (for call)'
        },
        tool: {
          type: 'string',
          description: 'Tool name (for call)'
        },
        args: {
          type: 'object',
          description: 'Tool arguments (for call)'
        }
      },
      required: ['action']
    },
    async execute(_id, params) {
      try {
        switch (params.action) {
          case 'list': {
            await mcpManager.ensureReady();
            const tools = mcpManager.listTools();
            return {
              content: [{
                type: 'text',
                text: tools.length > 0
                  ? JSON.stringify(tools, null, 2)
                  : formatEmptyToolsMessage(mcpManager.getStatus())
              }]
            };
          }

          case 'call': {
            if (!params.server || !params.tool) {
              throw new Error('server and tool are required for call action');
            }
            const result = await mcpManager.callTool(params.server, params.tool, params.args || {});
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }]
            };
          }

          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  });

  api.logger.info('[MCP] Plugin registered');
}

/** @internal Test helper */
export function __resetSharedManagerForTests() {
  sharedManager = null;
}
