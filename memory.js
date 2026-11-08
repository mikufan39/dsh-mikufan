/**
 * dsh-mikufan — Local memory engine (Host half, feature 3).
 *
 * A per-machine long-term memory store for the Harness agent, persisted as one
 * JSON document under `<DSH home>/dsh-mikufan/memory.json`. The agent reaches it
 * through four registered tools (`memory_write`, `memory_search`, `memory_list`,
 * `memory_delete`); the Web UI panel reaches it through the plugin's HTTP
 * routes; every session's prompt carries a compact generated index of the
 * enabled entries so the model knows what it remembers before it searches.
 *
 * Design (v2, after the 2026-11 review):
 * - Entries are atomic facts tagged user / feedback / project / reference (the
 *   Claude Code auto-memory taxonomy), not raw transcripts. A title (<= 80
 *   chars) is the index line; the body stays reachable through the tools — the
 *   v1 index truncated bodies to 160 chars and kept only 28% of their text.
 * - scope is "global" or "workspace:<normalized cwd>"; a session sees global
 *   entries plus the entries of the workspace it runs in (prefix match, so a
 *   session in a subdirectory still sees its project's facts).
 * - status (active / archived / superseded) and expiresAt give entries a
 *   lifecycle; pinned keeps a fact in the index regardless of recency;
 *   provenance records the session that wrote it; recall counts how often
 *   search returned it.
 * - Retrieval is BM25 over title (double weight) + body with CJK bigrams, so a
 *   long entry no longer outranks a precise one by sheer length (the v1
 *   character-coverage term produced 0.63 scores for unrelated facts).
 * - memory_write reports the near-duplicates it found while searching, so the
 *   model can decide UPDATE instead of ADD (the Mem0 "retrieve, then decide"
 *   pattern); this engine never silently merges, and nothing is deleted by a
 *   write.
 * - The index injection is bounded (entry count and title width), sorted
 *   newest-first after pinned, so a growing store cannot push fresh facts out
 *   of the prompt (v1 kept the OLDEST 40 entries).
 * - Every save rotates one dated backup per day, keeping the last seven.
 *
 * Everything is local: no network calls, no telemetry.
 *
 * @module dsh-mikufan/memory
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Memory document schema version (v1 entries are migrated on load). */
export const MEMORY_VERSION = 2;
/** Memory file name, under <DSH home>/dsh-mikufan/. */
export const MEMORY_FILE_NAME = 'memory.json';
/** Entry type vocabulary (Claude Code auto-memory taxonomy). */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
/** Entry lifecycle vocabulary. */
export const MEMORY_STATUSES = ['active', 'archived', 'superseded'];
/** Scope value that every session sees. */
export const GLOBAL_SCOPE = 'global';
/** Hard cap on stored entries; writes beyond it fail with an actionable message. */
export const MAX_ENTRIES = 200;
/** Hard cap on one entry's title length. */
export const MAX_TITLE_LENGTH = 80;
/** Hard cap on one entry's body length. */
export const MAX_CONTENT_LENGTH = 2000;
/** Body length above which memory_write returns a "split this" hint. */
export const BODY_HINT_LENGTH = 600;
/** Entries the generated index includes at most (prompt-budget fence). */
export const MAX_INDEX_ENTRIES = 40;
/** Index width per entry title. */
export const MAX_INDEX_TITLE = 80;
/** Character budget for the generated index lines (prompt-budget fence). */
export const MAX_INDEX_CHARS = 2400;
/** Near-duplicate score at which memory_write suggests an update. */
export const SIMILAR_SUGGEST_THRESHOLD = 0.45;
/** Near-duplicate margin below which the suggestion is reported as ambiguous. */
export const SIMILAR_AMBIGUOUS_MARGIN = 0.08;
/** Dated backups kept next to the store. */
export const BACKUP_RETENTION = 7;

/** [dsh-mikufan]-prefixed console reporter (same convention as index.js). */
function createLog() {
  return (message) => {
    console.log('[dsh-mikufan] ' + message);
  };
}

/** Whether the value is one of the declared entry types. */
function isMemoryType(value) {
  return typeof value === 'string' && MEMORY_TYPES.includes(value);
}

/** Whether the value is one of the declared lifecycle states. */
function isMemoryStatus(value) {
  return typeof value === 'string' && MEMORY_STATUSES.includes(value);
}

/** Normalize text for comparison: lowercase, collapse whitespace. */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a filesystem path for scope comparison: forward slashes, no
 * trailing slash, lower case (Windows paths compare case-insensitively; the
 * panel still shows the spelling the entry was written with).
 * @param path - raw path.
 * @returns the comparison form.
 */
export function normalizePath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Scope value for a working directory.
 * @param cwd - absolute directory of the session, or undefined.
 * @returns "global" when no directory is known, else workspace:<path>.
 */
export function workspaceScope(cwd) {
  const normalized = normalizePath(cwd);
  return normalized === '' ? GLOBAL_SCOPE : 'workspace:' + normalized;
}

/** Whether the value is a well-formed scope. */
export function isScope(value) {
  return value === GLOBAL_SCOPE || (typeof value === 'string' && value.startsWith('workspace:') && value.length > 'workspace:'.length);
}

/**
 * Whether an entry scope is visible from a session scope: every session sees
 * global entries, and a workspace entry is visible from its directory and from
 * any subdirectory (both directions, because a fact learned in a subdirectory
 * belongs to the project just as much).
 * @param entryScope - scope stored on the entry.
 * @param sessionScope - scope of the reading session, or undefined when unknown.
 */
export function scopeMatches(entryScope, sessionScope) {
  if (entryScope === GLOBAL_SCOPE) return true;
  if (typeof sessionScope !== 'string' || !sessionScope.startsWith('workspace:')) return false;
  const entryPath = entryScope.slice('workspace:'.length);
  const sessionPath = sessionScope.slice('workspace:'.length);
  if (entryPath === sessionPath) return true;
  return sessionPath.startsWith(entryPath + '/') || entryPath.startsWith(sessionPath + '/');
}

/**
 * Split text into retrieval tokens: ASCII/alphanumeric words of 2+ chars plus
 * overlapping CJK bigrams, so both an English phrase and a Chinese sentence
 * produce usable keywords without any segmentation dependency. Unlike
 * queryTerms this keeps duplicates: BM25 needs term frequencies.
 * @param text - raw text.
 * @returns the token list in reading order.
 */
export function tokenize(text) {
  const normalized = normalize(text);
  if (normalized === '') return [];
  const tokens = [];
  for (const part of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{Script=Han}/u.test(part)) {
      if (part.length === 1) tokens.push(part);
      else for (let i = 0; i < part.length - 1; i += 1) tokens.push(part.slice(i, i + 2));
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return tokens;
}

/**
 * Unique query terms, longest first (public helper kept from v1).
 * @param text - raw query or content.
 * @returns unique terms.
 */
export function queryTerms(text) {
  return [...new Set(tokenize(text))].sort((a, b) => b.length - a.length);
}

/**
 * v1 character-overlap score, kept for callers that still want the cheap
 * comparison (the store itself now ranks with BM25).
 * @returns the similarity score, 0..1.
 */
export function similarity(query, content) {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = normalize(content);
  if (haystack === '') return 0;
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  let score = hits / terms.length;
  const hanChars = [...new Set(normalize(query).match(/\p{Script=Han}/gu) ?? [])];
  if (hanChars.length >= 2) {
    let charHits = 0;
    for (const char of hanChars) if (haystack.includes(char)) charHits += 1;
    score = Math.max(score, charHits / hanChars.length);
  }
  if (haystack.includes(normalize(query))) score = Math.max(score, 0.9);
  return score;
}

/** Whether the entry is past its expiry date. */
function isExpired(entry, now = Date.now()) {
  return typeof entry.expiresAt === 'string' && Date.parse(entry.expiresAt) < now;
}

/** ISO timestamp validator. */
function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * First sentence (or first 60 chars) of a body, used when no title is given.
 * @param content - entry body.
 * @returns the derived title.
 */
export function deriveTitle(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  const stop = text.search(/[。！？!?\n;；]/);
  const sentence = stop >= 20 ? text.slice(0, stop) : text;
  return sentence.length > MAX_TITLE_LENGTH ? sentence.slice(0, MAX_TITLE_LENGTH - 1) + '…' : sentence;
}

/** Clamp a number into 0..1. */
function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

/** Credential-shaped text the user should not store. */
const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

/**
 * Whether text looks like it carries a credential.
 * @param text - text to inspect.
 * @returns whether a credential-shaped string was found.
 */
export function looksSensitive(text) {
  const value = String(text ?? '');
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Advisory hints for one write: long bodies, missing title, credential-shaped
 * text. Returned to the model instead of blocking the write.
 * @param options - content, title and whether the title was generated.
 * @returns hint sentences, possibly empty.
 */
export function reviewContent({ content, title, generatedTitle = false }) {
  const hints = [];
  const body = String(content ?? '');
  if (body.length > BODY_HINT_LENGTH) {
    hints.push(
      '正文 ' + body.length + ' 字偏长：记忆存「可复用的事实」，流程与变更日志交给 session_search；建议压到 ' +
        BODY_HINT_LENGTH + ' 字内或拆成多条。',
    );
  }
  if (generatedTitle) hints.push('未提供 title，已取正文首句；显式给 title 能让索引更可读。');
  if (looksSensitive(body) || looksSensitive(title)) {
    hints.push('正文疑似包含凭据/密钥；记忆是明文存储，请确认不要保存敏感信息。');
  }
  return hints;
}

/** Build the BM25 statistics for a document set. */
function buildIndex(docs) {
  const termFrequencies = [];
  const documentFrequency = new Map();
  for (const doc of docs) {
    const tf = new Map();
    for (const token of tokenize(doc.text)) tf.set(token, (tf.get(token) ?? 0) + 1);
    // The title is the curated one-line summary: weight its terms double.
    for (const token of tokenize(doc.title)) tf.set(token, (tf.get(token) ?? 0) + 2);
    for (const token of tf.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    const length = [...tf.values()].reduce((sum, value) => sum + value, 0) || 1;
    termFrequencies.push({ tf, length });
  }
  const averageLength =
    termFrequencies.reduce((sum, item) => sum + item.length, 0) / Math.max(1, termFrequencies.length) || 1;
  return { size: docs.length, documentFrequency, termFrequencies, averageLength };
}

/** BM25 score of document i for the given query tokens. */
function bm25(index, queryTokens, i, k1 = 1.2, b = 0.75) {
  let score = 0;
  const document = index.termFrequencies[i];
  for (const token of queryTokens) {
    const frequency = document.tf.get(token);
    if (frequency === undefined) continue;
    const df = index.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
    const denominator = frequency + k1 * (1 - b + (b * document.length) / index.averageLength);
    score += idf * ((frequency * (k1 + 1)) / denominator);
  }
  return score;
}

/** Map an unbounded BM25 score onto a display-friendly 0..1 range. */
function displayScore(score) {
  return Math.round((score / (score + 3)) * 100) / 100;
}

/** One durable memory entry. */
export class MemoryStore {
  /**
   * @param file - absolute path of the memory document.
   * @param log - reporter.
   */
  constructor(file, log = createLog()) {
    this.file = file;
    this.log = log;
    /** @type {Array<object>} */
    this.entries = [];
    this.writing = Promise.resolve();
  }

  /** Load the memory document; a missing or unreadable file starts empty. */
  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('memory unreadable: ' + (error?.message ?? error));
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
      this.entries = list.map((entry) => this.migrateEntry(entry)).filter((entry) => entry !== undefined);
      const version = typeof parsed?.version === 'number' ? parsed.version : 1;
      // v1 documents are rewritten once so the file carries the v2 shape; the
      // boot log stays quiet unless there was something to migrate.
      if (version < MEMORY_VERSION) {
        try {
          await this.save();
        } catch (error) {
          this.log('memory migration not persisted: ' + (error?.message ?? error));
          return;
        }
        if (this.entries.length > 0) {
          this.log('memory migrated v' + version + ' -> v' + MEMORY_VERSION + ': ' + this.entries.length + ' entries');
        }
      }
    } catch (error) {
      this.log('memory not valid JSON; starting empty (' + (error?.message ?? error) + ')');
    }
  }

  /**
   * Coerce one stored record into the current shape; unknown fields are
   * dropped and v1 records gain a title, a global scope and an active status.
   * @param raw - one parsed record.
   * @returns the entry, or undefined when it has no usable content.
   */
  migrateEntry(raw) {
    if (raw === null || typeof raw !== 'object') return undefined;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (content === '') return undefined;
    const createdAt = isIsoDate(raw.createdAt) ? raw.createdAt : new Date().toISOString();
    const updatedAt = isIsoDate(raw.updatedAt) ? raw.updatedAt : createdAt;
    const title =
      typeof raw.title === 'string' && raw.title.trim() !== ''
        ? raw.title.trim().slice(0, MAX_TITLE_LENGTH)
        : deriveTitle(content);
    return {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'mem-' + randomBytes(6).toString('hex'),
      title,
      content: content.slice(0, MAX_CONTENT_LENGTH),
      type: isMemoryType(raw.type) ? raw.type : 'project',
      scope: isScope(raw.scope) ? raw.scope : GLOBAL_SCOPE,
      source: raw.source === 'manual' ? 'manual' : 'agent',
      enabled: raw.enabled !== false,
      status: isMemoryStatus(raw.status) ? raw.status : 'active',
      pinned: raw.pinned === true,
      confidence: clamp01(raw.confidence ?? 1),
      provenance:
        raw.provenance !== null && typeof raw.provenance === 'object'
          ? {
              ...(typeof raw.provenance.sessionId === 'string' ? { sessionId: raw.provenance.sessionId } : {}),
              ...(isIsoDate(raw.provenance.at) ? { at: raw.provenance.at } : {}),
            }
          : null,
      recall: {
        count: Number.isFinite(raw.recall?.count) ? Math.max(0, Math.floor(raw.recall.count)) : 0,
        lastAt: isIsoDate(raw.recall?.lastAt) ? raw.recall.lastAt : null,
      },
      expiresAt: isIsoDate(raw.expiresAt) ? raw.expiresAt : null,
      supersededBy:
        typeof raw.supersededBy === 'string' && raw.supersededBy !== '' ? raw.supersededBy : null,
      createdAt,
      updatedAt,
    };
  }

  /** @returns the entries, oldest first. */
  list() {
    return [...this.entries];
  }

  /** @returns the entry with the id, or undefined. */
  get(id) {
    return this.entries.find((entry) => entry.id === id);
  }

  /**
   * Whether the entry is visible from a session scope; an unknown scope (a
   * caller without an Agent, e.g. a unit test) filters nothing.
   */
  inScope(entry, scope) {
    return scope === undefined ? true : scopeMatches(entry.scope, scope);
  }

  /**
   * Create one entry.
   * @param options - title, content, type, scope, pinned, expiresAt, source, provenance.
   * @returns the created entry.
   */
  async create({
    content,
    title,
    type = 'project',
    scope = GLOBAL_SCOPE,
    pinned = false,
    expiresAt = null,
    source = 'agent',
    provenance = null,
  } = {}) {
    const text = String(content ?? '').trim();
    if (text === '') throw new Error('memory content is required');
    if (text.length > MAX_CONTENT_LENGTH) {
      throw new Error('memory content exceeds ' + MAX_CONTENT_LENGTH + ' characters');
    }
    if (!isMemoryType(type)) {
      throw new Error('type must be one of ' + MEMORY_TYPES.join(', '));
    }
    if (!isScope(scope)) throw new Error('scope must be "global" or "workspace:<path>"');
    if (expiresAt !== null && !isIsoDate(expiresAt)) throw new Error('expiresAt must be an ISO timestamp');
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error('memory store is full (' + MAX_ENTRIES + ' entries); delete stale entries first');
    }
    const givenTitle = typeof title === 'string' ? title.trim() : '';
    if (givenTitle.length > MAX_TITLE_LENGTH) {
      throw new Error('memory title exceeds ' + MAX_TITLE_LENGTH + ' characters');
    }
    const now = new Date().toISOString();
    const entry = {
      id: 'mem-' + randomBytes(6).toString('hex'),
      title: givenTitle === '' ? deriveTitle(text) : givenTitle,
      content: text,
      type,
      scope: isScope(scope) ? scope : GLOBAL_SCOPE,
      source: source === 'manual' ? 'manual' : 'agent',
      enabled: true,
      status: 'active',
      pinned: pinned === true,
      confidence: 1,
      provenance: provenance !== null && typeof provenance === 'object' ? provenance : null,
      recall: { count: 0, lastAt: null },
      expiresAt,
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  /**
   * Update one entry.
   * @returns the updated entry, or undefined when the id is unknown.
   */
  async update(id, patch = {}) {
    const entry = this.get(id);
    if (entry === undefined) return undefined;
    if (typeof patch.content === 'string') {
      const text = patch.content.trim();
      if (text === '') throw new Error('memory content cannot be empty');
      if (text.length > MAX_CONTENT_LENGTH) {
        throw new Error('memory content exceeds ' + MAX_CONTENT_LENGTH + ' characters');
      }
      entry.content = text;
    }
    if (typeof patch.title === 'string') {
      const title = patch.title.trim();
      if (title.length > MAX_TITLE_LENGTH) {
        throw new Error('memory title exceeds ' + MAX_TITLE_LENGTH + ' characters');
      }
      entry.title = title === '' ? deriveTitle(entry.content) : title;
    }
    if (patch.type !== undefined) {
      if (!isMemoryType(patch.type)) {
        throw new Error('type must be one of ' + MEMORY_TYPES.join(', '));
      }
      entry.type = patch.type;
    }
    if (patch.scope !== undefined) {
      if (!isScope(patch.scope)) throw new Error('scope must be "global" or "workspace:<path>"');
      entry.scope = patch.scope;
    }
    if (patch.status !== undefined) {
      if (!isMemoryStatus(patch.status)) {
        throw new Error('status must be one of ' + MEMORY_STATUSES.join(', '));
      }
      entry.status = patch.status;
    }
    if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled;
    if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned;
    if (patch.confidence !== undefined) entry.confidence = clamp01(patch.confidence);
    if (patch.supersededBy !== undefined) {
      if (patch.supersededBy !== null && typeof patch.supersededBy !== 'string') {
        throw new Error('supersededBy must be an entry id or null');
      }
      entry.supersededBy = patch.supersededBy;
    }
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt !== null && !isIsoDate(patch.expiresAt)) {
        throw new Error('expiresAt must be an ISO timestamp or null');
      }
      entry.expiresAt = patch.expiresAt;
    }
    entry.updatedAt = new Date().toISOString();
    await this.save();
    return entry;
  }

  /**
   * Remove one entry.
   * @returns whether anything was removed.
   */
  async remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return false;
    await this.save();
    return true;
  }

  /**
   * Entries searchable from a scope: enabled, not superseded, scope-visible.
   * Expired entries stay searchable but are down-weighted.
   */
  searchable(scope) {
    return this.entries.filter(
      (entry) => entry.enabled && entry.status !== 'superseded' && this.inScope(entry, scope),
    );
  }

  /**
   * Rank entries with BM25 over title (double weight) and body.
   * @param query - raw query text.
   * @param options - limit, session scope, whether archived entries participate.
   * @returns matches with display scores, best first.
   */
  search(query, options = {}) {
    const { limit = 10, scope, includeArchived = true } = options;
    const candidates = this.searchable(scope).filter((entry) => includeArchived || entry.status === 'active');
    if (candidates.length === 0) return [];
    const index = buildIndex(candidates.map((entry) => ({ title: entry.title, text: entry.content })));
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const now = Date.now();
    const scored = candidates.map((entry, i) => {
      let score = bm25(index, tokens, i);
      if (entry.status === 'archived') score *= 0.45;
      if (isExpired(entry, now)) score *= 0.3;
      return { entry, score };
    });
    return scored
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || (a.entry.updatedAt < b.entry.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(({ entry, score }) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        type: entry.type,
        scope: entry.scope,
        status: entry.status,
        enabled: entry.enabled,
        updatedAt: entry.updatedAt,
        score: displayScore(score),
        recallCount: entry.recall.count,
      }));
  }

  /**
   * Near-duplicate lookup for memory_write: candidates that are active from the
   * writing session's scope.
   * @param text - the fact being written.
   * @param options - scope and limit.
   * @returns candidates with display scores.
   */
  similar(text, options = {}) {
    const { limit = 3, scope } = options;
    const candidates = this.searchable(scope).filter((entry) => entry.status === 'active');
    const index = buildIndex(candidates.map((entry) => ({ title: entry.title, text: entry.content })));
    const tokens = tokenize(text);
    if (tokens.length === 0) return [];
    return candidates
      .map((entry, i) => ({ entry, score: displayScore(bm25(index, tokens, i)) }))
      .filter((match) => match.score >= SIMILAR_SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, score }) => ({ id: entry.id, title: entry.title, score }));
  }

  /**
   * Count one recall for each returned entry (called by memory_search).
   * @param ids - entry ids the search returned.
   * @returns the save completion (skipped when nothing matched).
   */
  async recordRecall(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const id of ids) {
      const entry = this.get(id);
      if (entry === undefined) continue;
      entry.recall.count += 1;
      entry.recall.lastAt = now;
      changed = true;
    }
    if (changed) await this.save();
  }

  /**
   * The generated index injected into a session's prompt: one compact line per
   * visible entry — title only, pinned first, then newest first, capped by
   * MAX_INDEX_ENTRIES. Empty store contributes no text.
   * @param options - session scope and entry limit.
   * @returns the index text, or '' when there is nothing to remember.
   */
  indexText(options = {}) {
    const { scope, limit = MAX_INDEX_ENTRIES } = options;
    const now = Date.now();
    const visible = this.entries.filter(
      (entry) => entry.enabled && entry.status === 'active' && !isExpired(entry, now) && this.inScope(entry, scope),
    );
    if (visible.length === 0) return '';
    const sorted = [...visible].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : -1),
    );
    const lines = [];
    let used = 0;
    for (const entry of sorted) {
      if (lines.length >= limit) break;
      const title = entry.title.length > MAX_INDEX_TITLE ? entry.title.slice(0, MAX_INDEX_TITLE - 1) + '…' : entry.title;
      const line = '- [' + entry.type + '] ' + title.replace(/\s+/g, ' ');
      if (lines.length > 0 && used + line.length + 1 > MAX_INDEX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    const scopeNote =
      scope === undefined || scope === GLOBAL_SCOPE ? '' : ' in workspace ' + scope.slice('workspace:'.length);
    const header =
      visible.length > lines.length
        ? 'Long-term memory' + scopeNote + ' (showing ' + lines.length + ' of ' + visible.length + '; memory_search for the rest):'
        : 'Long-term memory' + scopeNote + ' (durable facts about the user, this machine, and ongoing work; memory_search lists details):';
    return [header, ...lines].join('\n');
  }

  /** The export document (stable shape for the panel's JSON download). */
  exportDoc() {
    return {
      version: MEMORY_VERSION,
      exportedAt: new Date().toISOString(),
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Merge a previously exported document into the store.
   * @param doc - parsed export document (or an entries array).
   * @param options - mode is "merge" (skip duplicates).
   * @returns counts of what happened.
   */
  async importDoc(doc, options = {}) {
    const { mode = 'merge' } = options;
    const list = Array.isArray(doc?.entries) ? doc.entries : Array.isArray(doc) ? doc : [];
    if (list.length === 0) throw new Error('import document contains no entries');
    const keyOf = (entry) => normalize(entry.title) + '|' + normalize(entry.content) + '|' + entry.scope;
    const existing = new Set(this.entries.map((entry) => keyOf(entry)));
    const existingIds = new Set(this.entries.map((entry) => entry.id));
    let imported = 0;
    let skipped = 0;
    for (const raw of list) {
      const entry = this.migrateEntry(raw);
      if (entry === undefined) {
        skipped += 1;
        continue;
      }
      if (mode === 'merge' && existing.has(keyOf(entry))) {
        skipped += 1;
        continue;
      }
      if (this.entries.length >= MAX_ENTRIES) throw new Error('memory store is full (' + MAX_ENTRIES + ' entries)');
      if (existingIds.has(entry.id)) entry.id = 'mem-' + randomBytes(6).toString('hex');
      entry.source = 'manual';
      this.entries.push(entry);
      existing.add(keyOf(entry));
      existingIds.add(entry.id);
      imported += 1;
    }
    if (imported > 0) await this.save();
    return { imported, skipped };
  }

  /**
   * Keep one dated backup per day (the state before the first write of that
   * day) and prune older ones. Best effort: a backup failure never blocks a
   * save.
   */
  async rotateBackup() {
    try {
      await stat(this.file);
    } catch {
      return; // nothing to back up yet
    }
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const backup = join(dirname(this.file), basename(this.file) + '.backup-' + stamp);
      try {
        await stat(backup);
      } catch {
        await copyFile(this.file, backup);
      }
      const prefix = basename(this.file) + '.backup-';
      const files = (await readdir(dirname(this.file))).filter((name) => name.startsWith(prefix)).sort();
      while (files.length > BACKUP_RETENTION) {
        const oldest = files.shift();
        await unlink(join(dirname(this.file), oldest));
      }
    } catch (error) {
      this.log('memory backup skipped: ' + (error?.message ?? error));
    }
  }

  /**
   * Persist the current entries atomically, serialized behind earlier writes.
   * The returned promise REJECTS on failure so a tool or route can report it;
   * the internal chain stays alive for the next write.
   * @returns the save completion.
   */
  save() {
    const snapshot = {
      version: MEMORY_VERSION,
      entries: this.entries,
      updatedAt: new Date().toISOString(),
    };
    const work = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await this.rotateBackup();
        const temporary = this.file + '.' + process.pid + '.tmp';
        await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
        await rename(temporary, this.file);
      });
    this.writing = work.catch(() => {});
    return work;
  }
}

/**
 * The four agent-facing tools over one store, as registry-ready plain
 * ToolDefinition objects. parameters is the JSON Schema object the registry
 * contract expects, output.schema stays inside the enforced JsonSchemaNode
 * subset, and execute values match those schemas exactly.
 *
 * @param store - the memory store.
 * @param options - resolveContext(exec) returns the calling session's scope,
 *   working directory and id so writes carry the right scope and provenance.
 * @returns the tool definitions.
 */
export function createMemoryTools(store, options = {}) {
  const { resolveContext } = options;
  const contextOf = (exec) => {
    try {
      return resolveContext?.(exec) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** Build one definition as written (no authoring helper; shapes are final). */
  const build = (definition) => definition;

  const similarOutput = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        score: { type: 'number' },
      },
      required: ['id', 'title', 'score'],
      additionalProperties: false,
    },
  };

  return [
    build({
      name: 'memory_write',
      description:
        'Save one durable fact to the local long-term memory (per machine, survives restarts). ' +
        'Use it when the user says "remember this" / "记住", or when you learn a durable fact worth carrying ' +
        'across sessions: the user\'s role or preferences (type "user"), corrections to your behavior (type "feedback"), ' +
        'project decisions and ongoing-work context that is NOT derivable from the codebase (type "project"), ' +
        'or pointers to external material (type "reference"). Keep it to ONE reusable fact: never store task logs, ' +
        'changelogs, or anything recoverable from the repo or session history. Do not store secrets or ephemeral state. ' +
        'scope "global" is for facts that apply in every workspace (identity, preferences); the default "auto" files ' +
        'the fact under the current workspace. The result lists similar existing entries; when one already covers the ' +
        'fact, call memory_write again with its id to update it instead of adding a near-duplicate.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact, as one self-contained sentence. 1–2000 characters.' },
          title: {
            type: 'string',
            description: 'Optional one-line title (<= 80 chars) used as the index line. Defaults to the first sentence.',
          },
          type: {
            type: 'string',
            enum: [...MEMORY_TYPES],
            description: 'Entry kind. Defaults to "project".',
          },
          scope: {
            type: 'string',
            enum: ['auto', 'global', 'workspace'],
            description: 'Where the fact applies. "auto" (default) = current workspace; "global" = every workspace.',
          },
          id: {
            type: 'string',
            description:
              'Existing entry id to update instead of adding (from a previous result\'s "similar" list or memory_search). Omit to add.',
          },
          supersede: {
            type: 'boolean',
            description:
              'With id: keep the old entry as history — create the new fact and mark the old one superseded ' +
              '(supersededBy = new id). Use it when the fact changed substantially or contradicts the old one; ' +
              'plain updates without this flag overwrite in place for small corrections.',
          },
          pinned: { type: 'boolean', description: 'Keep this entry in the prompt index regardless of recency.' },
          expires_at: { type: 'string', description: 'Optional ISO timestamp after which the fact is stale.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['created', 'updated'] },
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            scope: { type: 'string' },
            supersedes: { type: 'string' },
            similar: similarOutput,
            hint: { type: 'string' },
          },
          required: ['action', 'id', 'title', 'content', 'scope'],
          additionalProperties: false,
        },
        render(args, value) {
          const similar =
            Array.isArray(value.similar) && value.similar.length > 0
              ? ' Similar existing entries: ' +
                value.similar.map((item) => item.id + ' "' + item.title + '" (' + Math.round(item.score * 100) + '%)').join(', ') +
                '. If one already covers this fact, update it by id instead of keeping both.'
              : '';
          const hint = typeof value.hint === 'string' && value.hint !== '' ? ' ' + value.hint : '';
          const supersedes =
            typeof value.supersedes === 'string' && value.supersedes !== ''
              ? ' (supersedes ' + value.supersedes + '; the old entry is kept as superseded history)'
              : '';
          return [
            { type: 'text', text: 'Memory ' + value.action + ': ' + value.id + ' — ' + value.title + supersedes + similar + hint },
          ];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args, exec) {
        const content = typeof args?.content === 'string' ? args.content : '';
        const type = args?.type;
        const id = typeof args?.id === 'string' ? args.id : '';
        const context = contextOf(exec);
        const requestedScope = args?.scope;
        const scope =
          requestedScope === 'global'
            ? GLOBAL_SCOPE
            : requestedScope === 'workspace' || requestedScope === 'auto' || requestedScope === undefined
              ? context?.scope ?? GLOBAL_SCOPE
              : GLOBAL_SCOPE;
        const provenance =
          context?.sessionId !== undefined ? { sessionId: context.sessionId, at: new Date().toISOString() } : null;
        const similar = store.similar(content, { scope });
        const hints = reviewContent({ content, title: args?.title, generatedTitle: typeof args?.title !== 'string' });
        if (requestedScope === 'workspace' && context?.scope === undefined) {
          hints.push('当前会话没有可用的工作目录，这条已按 global 保存；要限定范围请在面板里改成工作区。');
        }
        if (similar.length > 1 && similar[0].score - similar[1].score < SIMILAR_AMBIGUOUS_MARGIN) {
          hints.push('多条候选分数接近：先 memory_search 看清区别再决定更新哪一条，避免覆盖错条目。');
        }
        const hint = hints.length > 0 ? hints.join(' ') : undefined;
        const expiresAt = typeof args?.expires_at === 'string' ? args.expires_at : undefined;
        const pinned = typeof args?.pinned === 'boolean' ? args.pinned : undefined;
        if (id !== '' && args?.supersede === true) {
          const previous = store.get(id);
          if (previous !== undefined) {
            // Append-only replacement: the new fact is a fresh entry and the old
            // one stays on disk as superseded history, so a contradictory update
            // never erases what the user said before.
            const created = await store.create({
              content,
              title: args?.title,
              type: type ?? previous.type,
              scope: requestedScope === 'global' || requestedScope === 'workspace' ? scope : previous.scope,
              pinned: pinned ?? previous.pinned,
              expiresAt: expiresAt !== undefined ? expiresAt : previous.expiresAt,
              provenance,
            });
            await store.update(previous.id, { status: 'superseded', supersededBy: created.id });
            return {
              action: 'created',
              id: created.id,
              title: created.title,
              content: created.content,
              scope: created.scope,
              supersedes: previous.id,
              similar,
              ...(hint !== undefined ? { hint } : {}),
            };
          }
        }
        if (id !== '') {
          const patch = {
            content,
            ...(type !== undefined ? { type } : {}),
            ...(requestedScope === 'global' || requestedScope === 'workspace' ? { scope } : {}),
            ...(pinned !== undefined ? { pinned } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          };
          const updated = await store.update(id, patch);
          if (updated === undefined) {
            const created = await store.create({ content, title: args?.title, type, scope, pinned, expiresAt, provenance });
            return {
              action: 'created',
              id: created.id,
              title: created.title,
              content: created.content,
              scope: created.scope,
              similar,
              hint:
                (hint !== undefined ? hint + ' ' : '') +
                'The requested id was unknown, so the fact was saved as a new entry.',
            };
          }
          return {
            action: 'updated',
            id: updated.id,
            title: updated.title,
            content: updated.content,
            scope: updated.scope,
            similar,
            ...(hint !== undefined ? { hint } : {}),
          };
        }
        const created = await store.create({ content, title: args?.title, type, scope, pinned, expiresAt, provenance });
        return {
          action: 'created',
          id: created.id,
          title: created.title,
          content: created.content,
          scope: created.scope,
          similar,
          ...(hint !== undefined ? { hint } : {}),
        };
      },
    }),
    build({
      name: 'memory_search',
      description:
        'Search the local long-term memory by keywords (English or Chinese; no regex). Use it when the injected ' +
        'memory index hints at something relevant but incomplete, or before asking the user for context they ' +
        'likely already gave you in an earlier session. Returns title + body + a match score.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords or a phrase to look for.' },
          scope: {
            type: 'string',
            enum: ['auto', 'global'],
            description: 'Search the current workspace plus global (default), or global entries only.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  type: { type: 'string' },
                  scope: { type: 'string' },
                  status: { type: 'string' },
                  enabled: { type: 'boolean' },
                  score: { type: 'number' },
                },
                required: ['id', 'title', 'content', 'type', 'scope', 'status', 'enabled', 'score'],
                additionalProperties: false,
              },
            },
            note: { type: 'string' },
          },
          required: ['matches'],
          additionalProperties: false,
        },
        render(args, value) {
          if (!Array.isArray(value.matches) || value.matches.length === 0) {
            return [{ type: 'text', text: 'No memory matches for that query.' }];
          }
          const lines = value.matches.map(
            (match, index) =>
              index +
              1 +
              '. [' +
              match.type +
              (match.status === 'active' ? '' : ', ' + match.status) +
              '] ' +
              match.title +
              ' (id ' +
              match.id +
              ', ' +
              Math.round(match.score * 100) +
              '%)\n   ' +
              match.content,
          );
          return [{ type: 'text', text: 'Memory matches:\n' + lines.join('\n') }];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args, exec) {
        const query = typeof args?.query === 'string' ? args.query : '';
        const context = contextOf(exec);
        const scope = args?.scope === 'global' ? GLOBAL_SCOPE : context?.scope ?? undefined;
        const matches = store.search(query, { limit: 10, scope }).map((match) => ({
          id: match.id,
          title: match.title,
          content: match.content,
          type: match.type,
          scope: match.scope,
          status: match.status,
          enabled: match.enabled,
          score: match.score,
        }));
        await store.recordRecall(matches.map((match) => match.id));
        return { matches, ...(matches.length === 0 ? { note: 'nothing matched; try broader keywords' } : {}) };
      },
    }),
    build({
      name: 'memory_list',
      description:
        'List the enabled stored long-term memories (most recently updated first). Optional type and status filters. ' +
        'Disabled entries are hidden — the user manages them from the panel.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Only entries of this kind.' },
          status: { type: 'string', enum: [...MEMORY_STATUSES], description: 'Only entries in this lifecycle state.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  type: { type: 'string' },
                  scope: { type: 'string' },
                  status: { type: 'string' },
                  pinned: { type: 'boolean' },
                  enabled: { type: 'boolean' },
                  expiresAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
                required: ['id', 'title', 'content', 'type', 'scope', 'status', 'pinned', 'enabled', 'updatedAt'],
                additionalProperties: false,
              },
            },
          },
          required: ['entries'],
          additionalProperties: false,
        },
        render(args, value) {
          if (!Array.isArray(value.entries) || value.entries.length === 0) {
            return [{ type: 'text', text: 'The long-term memory is empty.' }];
          }
          const lines = value.entries.map(
            (entry, index) =>
              index +
              1 +
              '. [' +
              entry.type +
              (entry.status === 'active' ? '' : ', ' + entry.status) +
              (entry.pinned ? ', pinned' : '') +
              '] ' +
              entry.title +
              ' (id ' +
              entry.id +
              ')',
          );
          return [{ type: 'text', text: 'Stored memories (' + value.entries.length + '):\n' + lines.join('\n') }];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args, exec) {
        const type = args?.type;
        const status = args?.status;
        const context = contextOf(exec);
        const entries = store
          .list()
          .filter((entry) => entry.enabled === true)
          .filter((entry) => !isMemoryType(type) || entry.type === type)
          .filter((entry) => !isMemoryStatus(status) || entry.status === status)
          .filter((entry) => store.inScope(entry, context?.scope))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, 50)
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            content: entry.content,
            type: entry.type,
            scope: entry.scope,
            status: entry.status,
            pinned: entry.pinned,
            enabled: entry.enabled,
            ...(entry.expiresAt !== null ? { expiresAt: entry.expiresAt } : {}),
            updatedAt: entry.updatedAt,
          }));
        return { entries };
      },
    }),
    build({
      name: 'memory_delete',
      description:
        'Delete one entry from the local long-term memory by id (from memory_search or memory_list). ' +
        'Use it when the user asks to forget something or when an entry is plainly obsolete. ' +
        'Deletion is final; prefer archiving when the fact is only stale.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The entry id to delete.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
            id: { type: 'string' },
          },
          required: ['deleted', 'id'],
          additionalProperties: false,
        },
        render(args, value) {
          return [
            {
              type: 'text',
              text: value.deleted ? 'Memory deleted: ' + value.id : 'No memory with id ' + value.id + '; nothing deleted.',
            },
          ];
        },
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id : '';
        const deleted = id !== '' ? await store.remove(id) : false;
        return { deleted, id };
      },
    }),
  ];
}

/**
 * Wire shape of one entry for the panel routes (never leaks internal fields).
 * @param entry - a stored entry.
 */
export function publicEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    type: entry.type,
    scope: entry.scope,
    source: entry.source,
    enabled: entry.enabled,
    status: entry.status,
    pinned: entry.pinned,
    confidence: entry.confidence,
    provenance: entry.provenance ?? null,
    recall: entry.recall ?? { count: 0, lastAt: null },
    expiresAt: entry.expiresAt ?? null,
    supersededBy: entry.supersededBy ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
