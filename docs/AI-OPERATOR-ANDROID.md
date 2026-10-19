# VORTEX AI Operator: Android local-model setup

The AI Operator is a site-wide advisory panel. It can send a prompt and optional **read-only** VORTEX health, summary, and recent-signal context to an OpenAI-compatible chat-completions endpoint. It never executes model-generated commands, changes settings, reads secret inventory, or triggers workflows.

## Suggested first model

For an Android device with 16 GB RAM, start with a **Qwen3 4B instruct GGUF at Q4 quantization** (for example, a Q4_K_M build). It is a reasonable first balance of quality and memory use; real speed depends on the phone's chipset, thermal limits, and context length. Keep context modest if the phone heats up or the app is killed. The model label in the UI must match the server's loaded model identifier.

## Run a local inference server

1. Install a trusted Android terminal/runtime and build or install a compatible `llama.cpp` build that supports `llama-server`.
2. Download a trusted Qwen3 4B instruct GGUF Q4 model. Check the model license and file integrity before use.
3. Start the server with its OpenAI-compatible chat-completions endpoint bound to loopback only (for example, `127.0.0.1:8080`). Do **not** bind to `0.0.0.0`, port-forward it, or expose it to the public internet.
4. In VORTEX, open **AI Operator**, set the endpoint to the server's `/v1/chat/completions` URL and enter the exact loaded model name.
5. Click **Inspect VORTEX status**, then ask a low-risk question such as “Explain the current health snapshot.”

The dashboard runs on HTTPS. Some Android browsers block a phone-local HTTP endpoint because of CORS or mixed-content policy; the Operator reports this instead of bypassing browser security. Do not solve this by exposing an unauthenticated model server. If local requests are blocked, use a trusted private same-origin backend bridge with authentication and rate limits, or run the dashboard locally on the phone.

## Security and current limits

- The endpoint and model name are stored in browser local storage; no API key is stored by this UI.
- Prompts and optional status context are sent to the configured endpoint. Keep it local/trusted and never include passwords, API keys, database URLs, or other secrets in prompts.
- Status context is restricted to health, summary and recent signal fields. The Operator does not call admin or secret-management endpoints.
- The model is advisory by default. If an operator supplies the backend admin token for the current browser session, it can request only the built-in read-only diagnostics and MCP tools explicitly allowlisted by the server operator. Each tool call requires browser confirmation and is audited.
- The model still cannot execute shell commands, change production settings, retrain the model, edit files, start GitHub Actions, write to GitHub, or merge a pull request. The token is held in page memory only and is not persisted in local storage.
- Configure MCP endpoints and per-server read-only tool allowlists in the worker environment. See [AI Operator MCP Plugins](./AI-OPERATOR-MCP-PLUGINS.md).
- Engineering automation should be added only through separate server-side, authenticated, allowlisted tools with audit logs, least privilege, explicit confirmation for consequential changes, and CI-tested pull-request workflows.

## References

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — local inference and OpenAI-compatible server.
- [Qwen model family](https://huggingface.co/Qwen) — model releases and licenses.
