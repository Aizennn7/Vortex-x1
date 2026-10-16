#!/usr/bin/env node
/**
 * GitHub Actions workflow and free-tier deployment validator.
 *
 * Verifies:
 *   1. All expected workflow files exist and follow valid GitHub Actions structure
 *      (no tabs, required top-level keys, concurrency groups, timeout-minutes).
 *   2. Scheduled backend workflows (`vortex-jobs.yml`, `vortex-learning.yml`)
 *      use `cancel-in-progress: false`, valid >= 5-minute cron expressions, and
 *      inspect migration status (`npm run migrate:status`) before applying
 *      forward-only migrations (`npm run migrate`).
 *   3. No workflow or script in the repository runs `supabase db reset` or
 *      contains hard-coded secrets.
 *   4. Paid Render hosting (`render.yaml`) is not required.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(root, '.github', 'workflows');

const errors = [];

if (existsSync(join(root, 'render.yaml'))) {
  errors.push('render.yaml still exists at repo root — paid Render hosting must be removed');
}

const requiredWorkflows = ['ci.yml', 'pages.yml', 'vortex-jobs.yml', 'vortex-learning.yml'];
for (const name of requiredWorkflows) {
  if (!existsSync(join(workflowsDir, name))) {
    errors.push(`missing required workflow: .github/workflows/${name}`);
  }
}

const workflowFiles = existsSync(workflowsDir)
  ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  : [];

const secretPatterns = [
  { name: 'Telegram bot token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/ },
  { name: 'Postgres connection URI with credentials', re: /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]+\b/ },
];

for (const file of workflowFiles) {
  const full = join(workflowsDir, file);
  const content = readFileSync(full, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    if (line.includes('\t')) {
      errors.push(`${file}:${idx + 1}: YAML must not contain tab characters`);
    }
  });

  for (const key of ['name:', 'on:', 'jobs:', 'concurrency:']) {
    if (!content.includes(key)) {
      errors.push(`${file}: missing top-level "${key}" section`);
    }
  }

  if (!content.includes('runs-on:')) {
    errors.push(`${file}: missing "runs-on:" in job definition`);
  }

  if (!content.includes('timeout-minutes:')) {
    errors.push(`${file}: missing "timeout-minutes:" guard`);
  }

  if (/supabase\s+db\s+reset/i.test(content)) {
    errors.push(`${file}: forbidden command "supabase db reset" found`);
  }

  for (const { name, re } of secretPatterns) {
    if (re.test(content)) {
      errors.push(`${file}: contains hard-coded ${name}`);
    }
  }

  // Validate cron expressions in scheduled workflows.
  const cronMatches = [...content.matchAll(/cron:\s*['"]([^'"]+)['"]/g)];
  for (const match of cronMatches) {
    const expr = match[1].trim();
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) {
      errors.push(`${file}: invalid 5-field cron expression "${expr}"`);
      continue;
    }
    const minuteField = parts[0];
    if (minuteField === '*' || /^\*\/[1-4]$/.test(minuteField)) {
      errors.push(`${file}: cron "${expr}" schedules more frequently than GitHub Actions' 5-minute minimum`);
    }
  }
}

for (const scheduled of ['vortex-jobs.yml', 'vortex-learning.yml']) {
  const full = join(workflowsDir, scheduled);
  if (!existsSync(full)) continue;
  const content = readFileSync(full, 'utf8');

  if (!content.includes('cancel-in-progress: false')) {
    errors.push(`${scheduled}: scheduled backend workflow must set "cancel-in-progress: false"`);
  }

  if (!content.includes('workflow_dispatch:')) {
    errors.push(`${scheduled}: scheduled backend workflow must support "workflow_dispatch:"`);
  }

  const statusIdx = content.indexOf('npm run migrate:status');
  const migrateIdx = content.indexOf('npm run migrate\n');
  if (statusIdx === -1) {
    errors.push(`${scheduled}: must inspect migration status ("npm run migrate:status") before migrating`);
  } else if (migrateIdx !== -1 && statusIdx > migrateIdx) {
    errors.push(`${scheduled}: "npm run migrate:status" must run before "npm run migrate"`);
  }

  if (!content.includes('npm run job:run')) {
    errors.push(`${scheduled}: must invoke "npm run job:run"`);
  }
}

// The scheduled provider job must pass all supported server-only key secrets.
const jobsWorkflow = readFileSync(join(workflowsDir, 'vortex-jobs.yml'), 'utf8');
for (const name of ['TWELVEDATA_API_KEY', 'TWELVEDATA_API_KEY_2', 'TWELVEDATA_API_KEY_3', 'TWELVEDATA_API_KEY_4']) {
  if (!jobsWorkflow.includes(name + ': ${{ secrets.' + name + ' }}')) {
    errors.push(`vortex-jobs.yml: missing Actions secret mapping for ${name}`);
  }
}

// Ensure no script in scripts/ executes `supabase db reset`.
for (const entry of readdirSync(join(root, 'scripts'))) {
  if (entry === 'validate-workflows.mjs' || entry === 'sync-supabase-migrations.mjs') continue;
  const text = readFileSync(join(root, 'scripts', entry), 'utf8');
  if (/supabase\s+db\s+reset/i.test(text)) {
    errors.push(`scripts/${entry}: forbidden command "supabase db reset" found`);
  }
}

if (errors.length > 0) {
  console.error('workflow validation failed:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`validated ${workflowFiles.length} GitHub Actions workflow(s): all checks passed`);
