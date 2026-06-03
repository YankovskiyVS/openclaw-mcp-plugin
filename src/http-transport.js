/**
 * Streamable HTTP Transport for MCP SDK
 * Wraps the official MCP SDK transport with OpenClaw-friendly options.
 */

import { StreamableHTTPClientTransport as SDKStreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

function buildRequestInit(options = {}) {
  const headers = {
    ...(options.headers || {}),
    Accept: MCP_ACCEPT,
  };

  return { headers };
}

export class StreamableHTTPClientTransport {
  constructor(url, options = {}) {
    this._debug = options.debug || false;
    this._transport = new SDKStreamableHTTPClientTransport(
      url instanceof URL ? url : new URL(url),
      {
        sessionId: options.sessionId || undefined,
        requestInit: buildRequestInit(options),
      }
    );
  }

  get onmessage() {
    return this._transport.onmessage;
  }

  set onmessage(handler) {
    this._transport.onmessage = handler;
  }

  get onerror() {
    return this._transport.onerror;
  }

  set onerror(handler) {
    this._transport.onerror = handler;
  }

  get onclose() {
    return this._transport.onclose;
  }

  set onclose(handler) {
    this._transport.onclose = handler;
  }

  async start() {
    if (this._debug) console.log('[Transport] Started');
    return this._transport.start();
  }

  async send(message, options) {
    if (this._debug) {
      console.log('[Transport] Sending:', JSON.stringify(message).substring(0, 200));
    }
    return this._transport.send(message, options);
  }

  async close() {
    if (this._debug) console.log('[Transport] Closing');
    return this._transport.close();
  }

  get sessionId() {
    return this._transport.sessionId;
  }

  setProtocolVersion(version) {
    return this._transport.setProtocolVersion(version);
  }

  async terminateSession() {
    return this._transport.terminateSession();
  }
}
