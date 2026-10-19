# VORTEX AI Operator: plugins, MCP and command gateway

The Operator gateway is an authenticated backend feature. It is intentionally not exposed as a public browser API: every route below is under `/admin` and requires the existing `Authorization: Bearer <VORTEX_ADMIN_TOKEN>` header. The browser must never contain a privileged token in local storage or a built asset.

## Built-in allowlisted commands

- `GET /admin/operator/commands` — list the fixed command allowlist.
- `POST /admin/operator/commands/diagnostics.health/run` — read health diagnostics.
- `POST /admin/operator/commands/signals.latest/run` — read the 20 most recent persisted signals.

These commands are read-only. Other command IDs are rejected. Each execution is written to the audit log.

## MCP server configuration

Set `VORTEX_MCP_SERVERS` in the **worker/relay server environment** (not a Vite variable or a GitHub Pages variable):

```json
[
  {
    "id": "github",
    "name": "GitHub MCP",
    "url": "https://api.githubcopilot.com/mcp/",
    "enabled": true,
    "readOnlyTools": []
  }
]
```

Set `VORTEX_MCP_TOKEN_GITHUB` in the same server's secret environment if the selected MCP endpoint requires a bearer token. Do not put tokens in the URL or JSON configuration. The remote server's authentication requirements and token type must be checked against its official documentation.

Use an empty `readOnlyTools` array initially. After checking the tool description and behavior returned by `GET /admin/operator/mcp/github/tools`, explicitly list only tools that have been reviewed as read-only. For example, a read-only repository search tool may be allowlisted; do not allowlist file-write, issue-write, PR-write, workflow-dispatch, shell, or deployment tools here. Tool names vary by MCP server and version.

## Endpoints

- `GET /admin/operator/plugins` — built-in integration metadata and configured MCP server IDs; endpoint URLs and credentials are not returned.
- `GET /admin/operator/mcp/:id/tools` — initialize the configured MCP session and discover tools.
- `POST /admin/operator/mcp/:id/call` — invoke one tool only if its name is explicitly present in that server's `readOnlyTools` list. Body: `{"toolName":"exact_name","arguments":{}}`.
- `GET /admin/operator/commands` — list the fixed local command allowlist.
- `POST /admin/operator/commands/:id/run` — run an allowlisted read-only command.

All routes use the existing admin bearer authentication, IP rate limits, response secret guard, and audit log. The MCP gateway uses a bounded request timeout and rejects redirects. Production MCP endpoints must use HTTPS; local HTTP endpoints are allowed only in non-production loopback development. The endpoint URL is controlled by the server environment, never by a user prompt or request body.

## Security boundaries and current scope

- The gateway does not accept arbitrary shell commands.
- Only server-configured MCP endpoints can be reached.
- Tool invocation is restricted to a server-operator-maintained read-only allowlist; discovery alone does not grant invocation rights.
- This first iteration does not implement browser-side OAuth consent, remote token refresh, writes to GitHub, workflow dispatch, pull-request merging, or unrestricted tool auto-selection by the local model.
- Do not treat a tool as read-only based only on its name. Review the upstream tool description and server trustworthiness before allowlisting it.
- MCP tools may return untrusted content. Treat tool output as data, not instructions. Keep the backend private or protected by a strong admin token and use least-privilege credentials.

The MCP protocol's authorization and security guidance calls for audience-bound tokens, secure token handling, HTTPS, and explicit privilege restriction; see the [official MCP authorization security considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx).
