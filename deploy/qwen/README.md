# Managed Qwen runtime for VORTEX

This directory documents the production architecture for operating Qwen as a managed part of VORTEX, rather than asking users to configure a separate model app.

## Current deployment boundary

VORTEX's public dashboard is static GitHub Pages and its scheduled worker jobs run on GitHub Actions. Neither provides a persistent inference host. Qwen's multi-gigabyte model must be downloaded to persistent server storage at deployment time and loaded by a long-running inference service.

The intended production setup is a private `llama.cpp` server reachable only from the VORTEX worker over a private service network. The browser should call an authenticated VORTEX backend proxy, never the model host directly. Do not expose the inference port publicly, commit model files, or put model-host credentials in Vite variables or GitHub Pages.

## Model

Use `Qwen3-4B-Q4_K_M.gguf` from the official [Qwen3-4B-GGUF repository](https://huggingface.co/Qwen/Qwen3-4B-GGUF). Verify the license, repository, and file hash at deployment time. Reserve several gigabytes for model storage plus runtime memory; practical RAM needs depend on context length, concurrency, and hardware.

## Required production wiring

1. Deploy `llama-server` with the model on a persistent host with sufficient RAM/CPU (or compatible GPU) and a persistent model cache.
2. Configure the worker with server-side `VORTEX_QWEN_BASE_URL` and `VORTEX_QWEN_MODEL`. Never expose these as `VITE_*` variables.
3. Implement an authenticated, rate-limited worker proxy for chat and health, with strict request/response size limits, timeouts, and audit events. The browser must not select arbitrary upstream URLs.
4. Wire the AI Operator to the worker proxy, not a user-configured model URL. Treat model output as untrusted and advisory; it must not directly invoke shell commands, modify settings, promote models, dispatch workflows, or place trades.
5. Add deployment health checks and alerting. Verify model readiness, successful inference, timeout handling, and safe behavior during outages before enabling it for users.

## Availability and cost

A permanently available cloud model requires a continuously running host with enough memory. Free scheduled runners cannot keep it online. This repository does not currently include cloud-host credentials, a configured persistent host, or a deployed model endpoint; this document is a deployment contract, not proof that Qwen is running.

## Trading boundary

Qwen is a language model for explanation and bounded orchestration. It must not replace VORTEX's deterministic signal gates or validated prediction model. It can summarize supplied data and propose diagnostics; it cannot guarantee profitable signals, self-modify production, or enable real-money trading.