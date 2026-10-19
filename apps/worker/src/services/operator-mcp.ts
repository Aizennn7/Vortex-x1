/**
 * VORTEX Operator MCP gateway.
 *
 * Servers are configured by an operator in VORTEX_MCP_SERVERS, never by a
 * browser-supplied URL. Only HTTPS servers are accepted in production.
 * Tool calls are restricted to the explicit per-server readOnlyTools allowlist.
 * No arbitrary shell/command execution is exposed here.
 */
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  readOnlyTools: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class OperatorMcpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    host === '0.0.0.0' || host === '127.0.0.1' || /^127\./.test(host) ||
    host === '169.254.169.254' || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function parseMcpServers(raw: string | undefined, production = process.env.NODE_ENV === 'production'): McpServerConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new OperatorMcpError(500, 'invalid_mcp_config', 'VORTEX_MCP_SERVERS must be valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new OperatorMcpError(500, 'invalid_mcp_config', 'VORTEX_MCP_SERVERS must be an array containing at most 20 servers.');
  }
  const ids = new Set<string>();
  return parsed.map((item): McpServerConfig => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorMcpError(500, 'invalid_mcp_config', 'Each MCP server entry must be an object.');
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const endpoint = typeof row.url === 'string' ? row.url.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || ids.has(id)) throw new OperatorMcpError(500, 'invalid_mcp_config', 'MCP server IDs must be unique alphanumeric identifiers.');
    ids.add(id);
    if (!name || name.length > 100) throw new OperatorMcpError(500, 'invalid_mcp_config', 'Each MCP server needs a short name.');
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new OperatorMcpError(500, 'invalid_mcp_config', `MCP server ${id} has an invalid URL.`); }
    if (url.username || url.password || url.search || url.hash) throw new OperatorMcpError(500, 'invalid_mcp_config', 'MCP URLs must not embed credentials, query strings, or fragments.');
    const localDev = !production && (url.protocol === 'http:' && isPrivateHostname(url.hostname));
    if (url.protocol !== 'https:' && !localDev) throw new OperatorMcpError(500, 'invalid_mcp_config', 'MCP servers must use HTTPS; HTTP is allowed only for loopback development.');
    if (production && isPrivateHostname(url.hostname)) throw new OperatorMcpError(500, 'invalid_mcp_config', 'Private and loopback MCP destinations are not allowed in production.');
    const readOnlyTools = Array.isArray(row.readOnlyTools)
      ? row.readOnlyTools.filter((v): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(v)).slice(0, 100)
      : [];
    return { id, name, url: url.toString(), enabled: row.enabled === true, readOnlyTools };
  });
}

export function listConfiguredMcpServers(): Array<Omit<McpServerConfig, 'url'>> {
  return parseMcpServers(process.env.VORTEX_MCP_SERVERS).map(({ url: _url, ...publicEntry }) => publicEntry);
}

function getServer(id: string): McpServerConfig {
  const server = parseMcpServers(process.env.VORTEX_MCP_SERVERS).find((entry) => entry.id === id);
  if (!server || !server.enabled) throw new OperatorMcpError(404, 'mcp_server_unavailable', 'MCP server is not configured or enabled.');
  return server;
}

const sessionIds = new Map<string, string>();

function tokenFor(id: string): string | undefined {
  const envKey = `VORTEX_MCP_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envKey] || undefined;
}

async function rpc(server: McpServerConfig, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
  const sessionId = sessionIds.get(server.id);
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const token = tokenFor(server.id);
  if (token) headers.authorization = `Bearer ${token}`;
  const notification = method.startsWith('notifications/');
  const response = await fetch(server.url, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: randomUUID() }), method, ...(params ? { params } : {}) }),
  });
  const returnedSession = response.headers.get('mcp-session-id');
  if (returnedSession) sessionIds.set(server.id, returnedSession);
  if (notification && (response.status === 202 || response.status === 204)) return null;
  if (!response.ok) throw new OperatorMcpError(502, 'mcp_upstream_error', `MCP server returned HTTP ${response.status}.`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new OperatorMcpError(502, 'mcp_transport_unsupported', 'MCP server did not return a JSON response. Configure a Streamable HTTP endpoint that supports JSON responses.');
  }
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new OperatorMcpError(502, 'mcp_rpc_error', payload.error.message || 'MCP request failed.');
  return payload.result;
}

async function initializeServer(server: McpServerConfig): Promise<void> {
  sessionIds.delete(server.id);
  await rpc(server, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'vortex-operator', version: '1.0.0' },
  });
  await rpc(server, 'notifications/initialized');
}

export async function discoverMcpTools(id: string): Promise<{ server: string; tools: McpTool[]; allowedReadOnlyTools: string[] }> {
  const server = getServer(id);
  const result = await rpc(server, 'tools/list') as { tools?: McpTool[] } | undefined;
  const tools = Array.isArray(result?.tools) ? result!.tools!.slice(0, 200).map((tool) => ({
    name: String(tool.name || '').slice(0, 100),
    description: typeof tool.description === 'string' ? tool.description.slice(0, 500) : undefined,
    inputSchema: tool.inputSchema,
  })).filter((tool) => tool.name) : [];
  return { server: server.id, tools, allowedReadOnlyTools: server.readOnlyTools };
}

export async function callReadOnlyMcpTool(id: string, toolName: string, args: unknown): Promise<unknown> {
  const server = getServer(id);
  if (!server.readOnlyTools.includes(toolName)) {
    throw new OperatorMcpError(403, 'tool_not_allowlisted', 'This tool is not explicitly allowlisted as read-only by the server operator.');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new OperatorMcpError(400, 'invalid_tool_arguments', 'Tool arguments must be a JSON object.');
  }
  const serialized = JSON.stringify(args);
  if (serialized.length > 16_000) throw new OperatorMcpError(413, 'tool_arguments_too_large', 'Tool arguments exceed 16 KB.');
  return rpc(server, 'tools/call', { name: toolName, arguments: args as Record<string, unknown> });
}
