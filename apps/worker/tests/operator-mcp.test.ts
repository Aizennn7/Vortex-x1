import { describe, expect, it } from 'vitest';
import { OperatorMcpError, parseMcpServers } from '../src/services/operator-mcp.js';

describe('VORTEX Operator MCP configuration', () => {
  it('returns no servers when no configuration is present', () => {
    expect(parseMcpServers(undefined, true)).toEqual([]);
  });

  it('accepts an HTTPS server and an explicit read-only tool allowlist', () => {
    const result = parseMcpServers(JSON.stringify([{
      id: 'github',
      name: 'GitHub MCP',
      url: 'https://api.githubcopilot.com/mcp/',
      enabled: true,
      readOnlyTools: ['search_repositories', 'get_file_contents', 'not safe; ignore'],
    }]), true);
    expect(result).toHaveLength(1);
    expect(result[0]?.readOnlyTools).toEqual(['search_repositories', 'get_file_contents']);
    expect(result[0]?.enabled).toBe(true);
  });

  it('rejects plain HTTP outside loopback development', () => {
    expect(() => parseMcpServers(JSON.stringify([{
      id: 'remote',
      name: 'Remote',
      url: 'http://example.com/mcp',
      enabled: true,
    }]), true)).toThrow(OperatorMcpError);
  });

  it('rejects loopback/private endpoints in production', () => {
    expect(() => parseMcpServers(JSON.stringify([{
      id: 'internal',
      name: 'Internal',
      url: 'https://127.0.0.1:8080/mcp',
      enabled: true,
    }]), true)).toThrow(/Private and loopback/);
  });

  it('allows loopback HTTP for local development only', () => {
    expect(parseMcpServers(JSON.stringify([{
      id: 'local',
      name: 'Local',
      url: 'http://127.0.0.1:8080/mcp',
      enabled: true,
    }]), false)).toHaveLength(1);
  });

  it('rejects duplicate IDs and malformed JSON', () => {
    const duplicate = [
      { id: 'github', name: 'GitHub', url: 'https://example.com/mcp', enabled: true },
      { id: 'github', name: 'Another', url: 'https://example.org/mcp', enabled: true },
    ];
    expect(() => parseMcpServers(JSON.stringify(duplicate), true)).toThrow(/unique/);
    expect(() => parseMcpServers('{bad json', true)).toThrow(/valid JSON/);
  });

  it('rejects embedded credentials and URL query strings', () => {
    expect(() => parseMcpServers(JSON.stringify([{
      id: 'creds',
      name: 'Credential URL',
      url: 'https://user:password@example.com/mcp',
      enabled: true,
    }]), true)).toThrow(/must not embed credentials/);
    expect(() => parseMcpServers(JSON.stringify([{
      id: 'query',
      name: 'Query URL',
      url: 'https://example.com/mcp?token=secret',
      enabled: true,
    }]), true)).toThrow(/must not embed credentials/);
  });
});
