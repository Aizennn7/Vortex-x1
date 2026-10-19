# Managed Qwen runtime for VORTEX

This directory documents a deployable inference runtime intended to be operated as part of the VORTEX service stack, not as a user-facing second app.

## Important deployment boundary

VORTEX's current public dashboard is static GitHub Pages and its worker jobs run as scheduled GitHub Actions. Neither is a persistent model host. A Qwen model cannot be made permanently available by adding a browser setting or by committing model weights to Git. The model is multiple gigabytes and must be downloaded into persistent server storage at deployment time.

The production target is a private `llama.cpp` server reachable only from the authenticated VORTEX worker over a private service network. The browser must call VORTEX's authenticated backend; it must never connect directly to the model host. Do not expose the inference port publicly, commit model files, or put model-host credentials in Vite variables or GitHub Pages.

## Model

Use `Qwen3-4B-Q4_K_M.gguf` from the official [Qwen3-4B-GGUF repository](https://huggingface.co/Qwen/Qwen3-4B-GGUF). Verify the license, repository, and file hash at deployment time. Allow several gigabytes for the model plus runtime memory; practical RAM needs depend on context length and concurrent requests.

## Required production wiring

1. Deploy `llama-server` with the model on a persistent host with adequate RAM/CPU (or compatible GPU), private networking, and a persistent model cache.
2. Bind the server to the private interface only. Configure the VORTEX worker with a server-side `VORTEX_QWEN_BASE_URL` and `VORTEX_QWEN_MODEL`; never expose these as `VITE_*` variables.
3. Add an authenticated, rate-limited worker proxy for chat and health, with strict request/response size limits, timeout, and audit events. The browser must not be able to select arbitrary upstream URLs.
4. Wire the AI Operator to the worker proxy, not to a user-configured model URL. Keep model output advisory and untrusted; it must not directly invoke shell commands, modify settings, promote models, dispatch workflows, or place trades.
5. Add deployment health checks and alerting; verify model readiness, one successful inference, timeout behavior, and failure-safe behavior before enabling it for users.

## Availability and cost

A permanently available cloud model needs a continuously running host with enough memory. Free scheduled runners cannot keep it online. This repository does not currently include cloud-host credentials, a configured persistent host, or a deployed model endpoint; adding this document does not mean Qwen is running. The runtime must be deployed and its endpoint configured before the dashboard can use it.

## Trading boundary

Qwen is a language model for explanation and orchestration. It must not replace VORTEX's deterministic signal gates or validated prediction model. It may summarize data and propose diagnostics; it cannot promise profitable signals, self-modify production, or enable real-money trading.