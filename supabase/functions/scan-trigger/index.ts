import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://aizennn7.github.io",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === "https://aizennn7.github.io" ? origin : "null" } });
  }
  if (origin !== "https://aizennn7.github.io") return Response.json({ error: "Origin not allowed" }, { status: 403, headers: corsHeaders });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });

  const githubToken = Deno.env.get("GITHUB_ACTIONS_TOKEN");
  const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const turnstileExpectedHost = Deno.env.get("TURNSTILE_HOSTNAME") ?? "aizennn7.github.io";
  if (!githubToken || !turnstileSecret) return Response.json({ error: "Scan trigger is not configured" }, { status: 503, headers: corsHeaders });

  let body: { profile?: unknown; turnstileToken?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders }); }
  const profile = body.profile;
  const turnstileToken = body.turnstileToken;
  if (profile !== "VIP" && profile !== "Session") return Response.json({ error: "Invalid scan profile" }, { status: 400, headers: corsHeaders });
  if (typeof turnstileToken !== "string" || turnstileToken.length < 10 || turnstileToken.length > 2048) return Response.json({ error: "Complete the human verification first" }, { status: 400, headers: corsHeaders });

  const verification = new FormData();
  verification.set("secret", turnstileSecret);
  verification.set("response", turnstileToken);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) verification.set("remoteip", ip);
  const verifyResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: verification });
  const verify = await verifyResponse.json().catch(() => ({})) as { success?: boolean; hostname?: string };
  if (!verifyResponse.ok || !verify.success || verify.hostname !== turnstileExpectedHost) {
    return Response.json({ error: "Human verification failed; try again" }, { status: 403, headers: corsHeaders });
  }

  const dispatch = await fetch("https://api.github.com/repos/Aizennn7/Vortex-x1/actions/workflows/vortex-jobs.yml/dispatches", {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job: "cycle" } }),
  });
  if (!dispatch.ok) return Response.json({ error: "GitHub did not accept the scan request" }, { status: 502, headers: corsHeaders });
  return Response.json({ accepted: true, profile, mode: "cycle" }, { status: 202, headers: corsHeaders });
});
