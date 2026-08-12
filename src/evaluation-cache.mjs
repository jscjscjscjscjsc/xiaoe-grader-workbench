import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(homedir(), '.xiaoe-grader');
const CACHE_PATH = join(CACHE_DIR, 'evaluation-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1500;

export function evaluationCacheKey({ rubric, model, web, imageUrls = [] }) {
  // Deliberately excludes student identity and API keys. A changed post body, code block,
  // image URL, rubric, or selected model naturally produces a new key.
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    rubric: String(rubric || '').trim(),
    provider: String(model?.baseUrl || '').replace(/\/+$/, ''),
    model: String(model?.model || ''),
    pageStatus: web?.status,
    text: web?.text || '',
    code: web?.code || [],
    imageUrls: [...imageUrls].sort()
  })).digest('hex');
}

export function getCachedEvaluation(key) {
  const entries = readEntries();
  const entry = entries[key];
  if (!entry || Date.now() - entry.createdAt > TTL_MS) return null;
  return { ...entry.result, cacheHit: true };
}

export function setCachedEvaluation(key, result) {
  const entries = readEntries();
  entries[key] = { createdAt: Date.now(), result: sanitize(result) };
  const kept = Object.entries(entries)
    .filter(([, value]) => Date.now() - value.createdAt <= TTL_MS)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, MAX_ENTRIES);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(kept)), 'utf8');
}

function readEntries() {
  try { return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}; } catch { return {}; }
}

function sanitize(result) {
  return {
    grade: result.grade,
    issues: Array.isArray(result.issues) ? result.issues : [],
    comment: result.comment,
    requiresReview: Boolean(result.requiresReview)
  };
}
