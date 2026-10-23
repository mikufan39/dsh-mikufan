/**
 * dsh-mikufan — Local memory engine (Host half, feature 3).
 *
 * A per-machine long-term memory store for the Harness agent, persisted as one
 * JSON document under `<DSH home>/dsh-mikufan/memory.json`. The agent reaches it
 * through four registered tools (`memory_write`, `memory_search`, `memory_list`,
 * `memory_delete`); the Web UI panel reaches it through the plugin's HTTP
 * routes; every session's system prompt carries a compact generated index of
 * the enabled entries so the model knows what it remembers before it searches.
 *
 * Design (from the industry survey, v1 scope):
 * - Entries are atomic facts tagged `user` / `feedback` / `project` /
 *   `reference` (the Claude Code auto-memory taxonomy), not raw transcripts.
 * - `memory_write` reports the near-duplicates it found while searching, so the
 *   model can decide UPDATE instead of ADD (the Mem0 "retrieve, then decide"
 *   pattern); this engine itself never silently merges.
 * - Replaced or rejected memories are never physically deleted by the engine —
 *   only the explicit delete tool or the panel removes an entry.
 * - The index injection is bounded (entry count and per-entry width), so a
 *   growing store cannot blow up the prompt.
 *
 * Everything is local: no network calls, no telemetry.
 *
 * @module dsh-mikufan/memory
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Memory document schema version. */
export const MEMORY_VERSION = 1;
/** Memory file name, under `<DSH home>/dsh-mikufan/`. */
export const MEMORY_FILE_NAME = 'memory.json';
/** Entry type vocabulary (Claude Code auto-memory taxonomy). */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
/** Hard cap on stored entries; writes beyond it fail with an actionable message. */
export const MAX_ENTRIES = 200;
/** Hard cap on one entry's content length. */
export const MAX_CONTENT_LENGTH = 2000;
/** Entries the generated index includes at most (prompt-budget fence). */
export const MAX_INDEX_ENTRIES = 40;
/** Index width per entry; full text stays reachable through the tools. */
export const MAX_INDEX_CONTENT = 160;
/** Near-duplicate score at which `memory_write` starts suggesting an update. */
export const SIMILAR_SUGGEST_THRESHOLD = 0.34;

/** `[dsh-mikufan]`-prefixed console reporter (same convention as index.js). */
function createLog() {
  return (message) => {
    console.log(`[dsh-mikufan] ${message}`);
  };
}

/** Whether the value is one of the declared entry types. */
function isMemoryType(value) {
  return typeof value === 'string' && MEMORY_TYPES.includes(value);
}

/** Normalize text for comparison: lowercase, collapse whitespace. */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split one query into match terms: ASCII words plus CJK bigrams, so both an
 * English phrase and a Chinese sentence produce usable keywords without any
 * segmentation dependency.
 * @param text - raw query or content.
 * @returns unique terms, longest first.
 */
export function queryTerms(text) {
  const normalized = normalize(text);
  if (normalized === '') return [];
  const terms = new Set();
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) terms.add(word);
  }
  const cjkRuns = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) terms.add(run.slice(i, i + 2));
    }
    if (run.length <= 4) terms.add(run);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

/**
 * Score how much of `query` appears in `content`: the share of query terms
 * found as substrings, a Han-character coverage term so paraphrased Chinese
 * still matches, and a bonus for an exact normalized containment. 0..1.
 * @returns the similarity score.
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

/** One durable memory entry. */
export class MemoryStore {
  /**
   * @param file - absolute path of the memory document.
   * @param log - reporter.
   */
  constructor(file, log = createLog()) {
    this.file = file;
    this.log = log;
    /** @type {Array<{ id: string, content: string, type: string, source: string, enabled: boolean, createdAt: string, updatedAt: string }>} */
    this.entries = [];
    this.writing = Promise.resolve();
  }

  /** Load the memory document; a missing or unreadable file starts empty. */
  async load() {
    let text;
    try {
      const { readFile } = await import('node:fs/promises');
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`memory file unreadable (${error?.message ?? error}); starting empty`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
      this.entries = list.filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.content === 'string',
      );
      this.log(`loaded ${this.entries.length} memor${this.entries.length === 1 ? 'y' : 'ies'}`);
    } catch (error) {
      this.log(`memory file is not valid JSON (${error?.message ?? error}); starting empty`);
    }
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
   * Create one entry.
   * @param options - content, optional type, optional source tag.
   * @returns the created entry.
   */
  async create({ content, type = 'project', source = 'agent' }) {
    const text = String(content ?? '').trim();
    if (text === '') throw new Error('memory content is required');
    if (text.length > MAX_CONTENT_LENGTH) {
      throw new Error(`memory content exceeds ${MAX_CONTENT_LENGTH} characters`);
    }
    if (!isMemoryType(type)) {
      throw new Error(`type must be one of ${MEMORY_TYPES.join(', ')}`);
    }
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(`memory store is full (${MAX_ENTRIES} entries); delete stale entries first`);
    }
    const now = new Date().toISOString();
    const entry = {
      id: `mem-${randomBytes(6).toString('hex')}`,
      content: text,
      type,
      source: source === 'manual' || source === 'agent' ? source : 'agent',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  /**
   * Update one entry's content and/or type.
   * @returns the updated entry, or undefined when the id is unknown.
   */
  async update(id, patch = {}) {
    const entry = this.get(id);
    if (entry === undefined) return undefined;
    if (typeof patch.content === 'string') {
      const text = patch.content.trim();
      if (text === '') throw new Error('memory content cannot be empty');
      if (text.length > MAX_CONTENT_LENGTH) {
        throw new Error(`memory content exceeds ${MAX_CONTENT_LENGTH} characters`);
      }
      entry.content = text;
    }
    if (patch.type !== undefined) {
      if (!isMemoryType(patch.type)) {
        throw new Error(`type must be one of ${MEMORY_TYPES.join(', ')}`);
      }
      entry.type = patch.type;
    }
    if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled;
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
   * Keyword search over all entries, enabled or not (labelled in the result).
   * @param query - raw query text.
   * @param limit - maximum matches.
   * @returns matches with their scores, best first.
   */
  search(query, limit = 10) {
    const scored = this.entries
      .map((entry) => ({ entry, score: similarity(query, entry.content) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || (a.entry.updatedAt < b.entry.updatedAt ? 1 : -1));
    return scored.slice(0, limit).map(({ entry, score }) => ({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      enabled: entry.enabled,
      updatedAt: entry.updatedAt,
      score: Math.round(score * 100) / 100,
    }));
  }

  /**
   * The generated index injected into every session's prompt: one compact line
   * per enabled entry, capped by {@link MAX_INDEX_ENTRIES}. Empty store
   * contributes no text.
   * @returns the index text, or '' when there is nothing to remember.
   */
  indexText() {
    const enabled = this.entries.filter((entry) => entry.enabled);
    if (enabled.length === 0) return '';
    const lines = enabled.slice(0, MAX_INDEX_ENTRIES).map((entry) => {
      const text = entry.content.length > MAX_INDEX_CONTENT ? `${entry.content.slice(0, MAX_INDEX_CONTENT)}…` : entry.content;
      return `- [${entry.type}] ${text.replace(/\s+/g, ' ')}`;
    });
    const header =
      enabled.length > MAX_INDEX_ENTRIES
        ? `Long-term memory (showing ${MAX_INDEX_ENTRIES} of ${enabled.length}; use memory_search for more):`
        : 'Long-term memory (durable facts about the user, this machine, and ongoing work; memory_search lists details):';
    return [header, ...lines].join('\n');
  }

  /** Persist the current entries atomically, serialized behind earlier writes. */
  save() {
    const snapshot = {
      version: MEMORY_VERSION,
      entries: this.entries,
      updatedAt: new Date().toISOString(),
    };
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await rename(temporary, this.file);
      })
      .catch((error) => {
        this.log(`failed to save memories: ${error?.message ?? error}`);
      });
    return this.writing;
  }
}

/**
 * The four agent-facing tools over one store, as registry-ready plain
 * ToolDefinition objects: `parameters` is the JSON Schema object the registry
 * contract (`ToolSchema.parameters`) expects, `output.schema` stays inside the
 * enforced JsonSchemaNode subset, and execute values match those schemas
 * exactly (validation is registry-owned, not defineTool-owned). Writes
 * serialize through the store's own write chain, so `isConcurrencySafe` stays
 * honest.
 *
 * @param store - the memory store.
 * @param log - reporter.
 * @returns the tool definitions.
 */
export function createMemoryTools(store, log = createLog()) {
  const similarOf = (content) =>
    store
      .list()
      .map((entry) => ({ id: entry.id, content: entry.content, score: similarity(content, entry.content) }))
      .filter((match) => match.score >= SIMILAR_SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

  /** Build one definition as written (no authoring helper; shapes are final). */
  const build = (definition) => definition;

  return [
    build({
      name: 'memory_write',
      description:
        'Save one durable fact to the local long-term memory (per machine, survives restarts). ' +
        'Use it when the user says "remember this" / "记住", or when you learn a durable fact worth carrying ' +
        'across sessions: the user\'s role or preferences (type "user"), corrections to your behavior (type "feedback"), ' +
        'project decisions and ongoing-work context that is NOT derivable from the codebase (type "project"), ' +
        'or pointers to external material (type "reference"). Do not store secrets, credentials, or ephemeral task state. ' +
        'The result lists similar existing entries; when one already covers the fact, call memory_write again ' +
        'with its id to update it instead of adding a near-duplicate.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact, as one self-contained sentence. 1–2000 characters.' },
          type: {
            type: 'string',
            enum: [...MEMORY_TYPES],
            description: 'Entry kind. Defaults to "project".',
          },
          id: {
            type: 'string',
            description:
              'Existing entry id to update instead of adding (from a previous result\'s "similar" list or memory_search). Omit to add.',
          },
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
            content: { type: 'string' },
            similar: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  score: { type: 'number' },
                },
                required: ['id', 'content', 'score'],
                additionalProperties: false,
              },
            },
            hint: { type: 'string' },
          },
          required: ['action', 'id', 'content'],
          additionalProperties: false,
        },
        render(args, value) {
          const similar =
            Array.isArray(value.similar) && value.similar.length > 0
              ? ` Similar existing entries: ${value.similar
                  .map((item) => `${item.id} (${Math.round(item.score * 100)}%)`)
                  .join(', ')}. If one already covers this fact, update it by id instead of keeping both.`
              : '';
          const hint = typeof value.hint === 'string' && value.hint !== '' ? ` ${value.hint}` : '';
          return [{ type: 'text', text: `Memory ${value.action}: ${value.id}${similar}${hint}` }];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args) {
        const content = typeof args?.content === 'string' ? args.content : '';
        const type = args?.type;
        const id = args?.id;
        const similar = similarOf(content);
        if (typeof id === 'string' && id !== '') {
          const updated = await store.update(id, { content, ...(type !== undefined ? { type } : {}) });
          if (updated === undefined) {
            const created = await store.create({ content, ...(type !== undefined ? { type } : {}) });
            log(`memory written by agent (requested id was unknown): ${created.id}`);
            return {
              action: 'created',
              id: created.id,
              content: created.content,
              similar,
              hint: `The requested id was unknown, so the fact was saved as a new entry.`,
            };
          }
          log(`memory updated by agent: ${updated.id}`);
          return { action: 'updated', id: updated.id, content: updated.content, similar };
        }
        const created = await store.create({ content, ...(type !== undefined ? { type } : {}) });
        log(`memory written by agent: ${created.id}`);
        return { action: 'created', id: created.id, content: created.content, similar };
      },
    }),
    build({
      name: 'memory_search',
      description:
        'Search the local long-term memory by keywords (English or Chinese; no regex). Use it when the injected ' +
        'memory index hints at something relevant but incomplete, or before asking the user for context they ' +
        'likely already gave you in an earlier session.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords or a phrase to look for.' },
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
                  content: { type: 'string' },
                  type: { type: 'string' },
                  enabled: { type: 'boolean' },
                  score: { type: 'number' },
                },
                required: ['id', 'content', 'type', 'enabled', 'score'],
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
              `${index + 1}. [${match.type}${match.enabled ? '' : ', disabled'}] ${match.content} (id ${match.id}, ${Math.round(match.score * 100)}%)`,
          );
          return [{ type: 'text', text: `Memory matches:\n${lines.join('\n')}` }];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query : '';
        const matches = store.search(query, 10).map(({ id, content, type, enabled, score }) => ({
          id,
          content,
          type,
          enabled,
          score,
        }));
        return { matches, ...(matches.length === 0 ? { note: 'nothing matched; try broader keywords' } : {}) };
      },
    }),
    build({
      name: 'memory_list',
      description: 'List the stored long-term memories (most recently updated first). Optional type filter.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Only entries of this kind.' },
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
                  content: { type: 'string' },
                  type: { type: 'string' },
                  enabled: { type: 'boolean' },
                  updatedAt: { type: 'string' },
                },
                required: ['id', 'content', 'type', 'enabled', 'updatedAt'],
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
            (entry, index) => `${index + 1}. [${entry.type}${entry.enabled ? '' : ', disabled'}] ${entry.content} (id ${entry.id})`,
          );
          return [{ type: 'text', text: `Stored memories (${value.entries.length}):\n${lines.join('\n')}` }];
        },
      },
      isConcurrencySafe() {
        return true;
      },
      async execute(args) {
        const type = args?.type;
        const entries = store
          .list()
          .filter((entry) => !isMemoryType(type) || entry.type === type)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, 50)
          .map((entry) => ({
            id: entry.id,
            content: entry.content,
            type: entry.type,
            enabled: entry.enabled,
            updatedAt: entry.updatedAt,
          }));
        return { entries };
      },
    }),
    build({
      name: 'memory_delete',
      description:
        'Delete one entry from the local long-term memory by id (from memory_search or memory_list). ' +
        'Use it when the user asks to forget something or when an entry is plainly obsolete.',
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
              text: value.deleted ? `Memory deleted: ${value.id}` : `No memory with id ${value.id}; nothing deleted.`,
            },
          ];
        },
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id : '';
        const deleted = id !== '' ? await store.remove(id) : false;
        if (deleted) log(`memory deleted by agent: ${id}`);
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
    content: entry.content,
    type: entry.type,
    source: entry.source,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
