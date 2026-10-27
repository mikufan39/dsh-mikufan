/**
 * dsh-mikufan — Host half.
 *
 * Component 1, "Delete-sessions":
 *
 * 1. Startup sweep: every session marked for deletion is physically removed at
 *    Harness startup — its session log directory, its projection-cache file and
 *    its registry references. A live (in-process) session is never touched.
 *    The sweep also takes the marked session's subagent sessions with it:
 *    the `sessionQuery` service's `parentSession` headers reveal the subagent
 *    tree, and every discovered descendant is deleted through the same
 *    liveness fence right after its parent. A failed descendant deletion is
 *    marked for the next startup, riding the same durable retry path as a
 *    user-made mark; the user's own marked set is never inflated by it.
 * 2. Release on continued conversation: a user message committed to a marked
 *    session cancels its mark, so "keep talking" and "delete me" cannot both be
 *    pending.
 * 3. The HTTP endpoints the sidebar UI uses to mark / unmark / read the marked
 *    set (`<prefix>/marked`, `<prefix>/mark`, `<prefix>/unmark`).
 *
 * Component 2, "Startup animation": the Web page's boot cover is contributed
 * through `webserver/index-inject` (before the app module runs), the animation
 * document is served from `GET /mikufan/splash`, and `<prefix>/splash` reads /
 * writes the on/off preference (`preferences.json`). See `splash.js`.
 *
 * Component 3, "Local memory": a per-machine long-term memory store for the
 * agent (`memory.js`), reachable through four registered tools, a generated
 * index injected into every session's system prompt, and the panel routes
 * (`<prefix>/memory…`). All feature switches — these three included — live on
 * the sidebar "Control panel" page contributed by the Client half.
 *
 * Component 4, "LAN access" (`lan.js`, integrated from the superseded
 * standalone dsh-lan-access bundle): a second, no-token reverse-proxy
 * listener for phones and other LAN devices. The main listener stays
 * loopback-only; the proxy is user-enabled from the Control panel's 局域网
 * 访问 page and reaches the same `<prefix>/lan/…` routes through it.
 *
 * Component 5, "Skills" (`skills.js`): the Skill page of the Control panel
 * manages the user skill root the Harness already scans
 * (`<DSH home>/skills`). The root is created on first run, the bundled
 * `skill-creator` skill is installed into it once (never overwritten), and
 * `<prefix>/skills…` serves list / detail / enable / reveal / remove.
 *
 * Component 6, "Agent" (`agent.js`): the Agent page edits the user-global
 * instruction file the Harness loads for every project
 * (`<DSH home>/AGENTS.md`). `<prefix>/agent` reads and writes that one file;
 * blank text removes it. Project-level `AGENTS.md` files still apply.
 *
 * Component 7, "MCP" (`mcp.js`): the MCP page manages the OpenAI ChatGPT /
 * Codex `mcp_servers.<name>` configuration (stdio / streamable_http) in
 * `<DSH home>/dsh-mikufan/mcp.json`; `<prefix>/mcp…` lists, creates, edits,
 * enables and removes the servers.
 *
 * Component 8, "One-click restart" (`restart.js` + `relaunch.mjs`): the
 * dashboard card arms a six-second Host-side countdown; `<prefix>/restart`
 * reads and flips it. Firing spawns a detached helper that waits for this pid
 * to exit and then starts the same command line again, while the launcher's
 * `appExit` service tears the tree down in order. A running session always
 * blocks the plan — a restart never cuts a conversation.
 *
 * The marked set lives in its own JSON file, never in `workspace.json`: that
 * document's in-memory state is authoritative while the Host runs, so a raw
 * file edit would be silently republished. Registry references are therefore
 * removed through the open storage domain when it exists, and only through the
 * file when no domain has loaded the document yet.
 *
 * @module dsh-mikufan
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __splashInternal,
  createSplashRouteHandler,
  readSplashAsset,
  splashIndexInjections,
  SPLASH_ROUTE,
} from './splash.js';
import { createMemoryTools, MEMORY_FILE_NAME, MemoryStore, publicEntry, queryTerms, similarity } from './memory.js';
import {
  countRunningSessions,
  relaunchDsh,
  RESTART_DELAY_MS,
  RESTART_LOG_NAME,
  RESTART_SHUTDOWN_WATCHDOG_MS,
  RestartController,
} from './restart.js';
import {
  cleanLanHost,
  cleanLanMaxConnections,
  cleanLanPort,
  clearDetectedAddresses,
  detectPrivateIpv4List,
  effectiveLanAccessEnabled,
  isWildcardAddress,
  LAN_DEFAULT_MAX_CONNECTIONS,
  LAN_DEFAULT_PORT,
  LAN_MAX_CONNECTIONS_LIMIT,
  LAN_PREFERENCES_FILE_NAME,
  LanProxy,
  readLanPreferences,
  resetLanAccessOnStartup,
  saveLanPreferences,
  urlHost,
} from './lan.js';
import {
  ensureSkillsRoot,
  installBundledSkill,
  listSkills,
  readSkill,
  removeSkill,
  restoreBundledSkill,
  setSkillEnabled,
  SKILLS_DIR_NAME,
} from './skills.js';
import { readAgentInstructions, saveAgentInstructions } from './agent.js';
import {
  MAX_MCP_BODY_BYTES,
  MAX_MCP_SERVERS,
  McpStore,
  normalizeMcpServer,
  publicServer,
  readMcpServers,
  writeMcpServers,
} from './mcp.js';

/** Plugin package name; also the loader row id. */
const PLUGIN_NAME = 'dsh-mikufan';
/** Underlying web route prefix (the Client half fetches under the page base). */
const ROUTE_PREFIX = '/mikufan/api';
/**
 * How long a startup with marked sessions waits before sweeping them.
 *
 * Listing the session corpus is the one startup step that grows with the user's
 * history (≈0.5 ms per session), so it runs just after the boot burst instead of
 * competing with the first render and the first request. A process that exits
 * before the timer still keeps its marks, and the next start retries them.
 */
const SWEEP_DELAY_MS = 1500;
/** Largest accepted request body for the mark endpoints. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * Largest accepted request body for the AGENTS.md editor.
 *
 * The text limit is 64 Ki characters and JSON-escaped CJK text costs up to
 * three bytes per character, so the envelope needs far more room than the
 * ordinary JSON endpoints.
 */
const MAX_AGENT_BODY_BYTES = 512 * 1024;
/** State file name of the MCP server document (`mcp.js`), under `<DSH home>/<plugin>/`. */
const MCP_STATE_FILE_NAME = 'mcp.json';
/** A session id safe to use as a path segment and in a CSS attribute selector. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
/** Own state file name, under `<DSH home>/dsh-mikufan/`. */
const STATE_FILE_NAME = 'delete-sessions.json';
/** Own preference file name, under `<DSH home>/dsh-mikufan/`. */
const PREFERENCES_FILE_NAME = 'preferences.json';
/** State file schema version. */
const STATE_VERSION = 1;
/** Preference file schema version (2 adds the delete-sessions switch). */
const PREFERENCES_VERSION = 3;
/** Storage domain + unit that owns `storages/workspace.json`. */
const WORKSPACE_DOMAIN = 'workspace';
/** Table inside that domain. */
const WORKSPACES_TABLE = 'workspaces';
/**
 * Process-wide claim of the startup sweep.
 *
 * The sweep belongs to a cold start, not to every activation: a config edit or
 * an HMR reload re-runs `apply` inside a running Host, and deleting an idle
 * marked session there would be a surprise, not the promised "on next startup".
 * The claim is synchronous, so two concurrent activations cannot both run it.
 */
const STARTUP_SWEEP_CLAIM = Symbol.for('dsh-mikufan.startup-sweep');

/**
 * Resolve the DeepSeek Harness home exactly like `@deepseek-ai/dsh-home-paths`:
 * `$DSH_HOME` (with `~` expansion and blank = unset) first, then `~/.dsh`.
 * @returns the absolute harness home path.
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') {
    const raw = configured.trim();
    if (raw === '~') return homedir();
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
    return resolve(raw);
  }
  return join(homedir(), '.dsh');
}

/** `[dsh-mikufan]`-prefixed console reporter. */
function createLog() {
  return (message) => {
    console.log(`[${PLUGIN_NAME}] ${message}`);
  };
}

/** Test one string against {@link SESSION_ID_PATTERN}. */
function isSafeSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/**
 * Whether a path exists.
 * @param path - absolute path.
 * @returns true when the path exists.
 */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The durable set of session ids marked for deletion.
 *
 * Writes are serialized and atomic (temp file + rename) so a crash mid-write
 * never leaves a truncated list behind.
 */
class DeleteSessionStore {
  /**
   * @param file - absolute path of the state file.
   * @param log - reporter.
   */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    /** @type {Set<string>} */
    this.ids = new Set();
    this.writing = Promise.resolve();
  }

  /** Load the state file; a missing or unreadable file starts empty. */
  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`delete-marks unreadable: ${error?.message ?? error}`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.markedSessionIds) ? parsed.markedSessionIds : [];
      this.ids = new Set(list.filter(isSafeSessionId));
    } catch {
      this.log('delete-marks not valid JSON; starting empty');
    }
  }

  /** @returns the marked ids, in insertion order. */
  list() {
    return [...this.ids];
  }

  /** @returns whether the id is marked. */
  has(id) {
    return this.ids.has(id);
  }

  /**
   * Add one id.
   * @returns whether the set changed.
   */
  add(id) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }

  /**
   * Remove one id.
   * @returns whether the set changed.
   */
  remove(id) {
    return this.ids.delete(id);
  }

  /** Persist the current set atomically, serialized behind earlier writes. */
  save() {
    const snapshot = {
      version: STATE_VERSION,
      markedSessionIds: this.list(),
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
        this.log(`could not save delete marks: ${error?.message ?? error}`);
      });
    return this.writing;
  }
}

/**
 * The plugin's small durable preference set: one built-in switch per feature.
 *
 * Preferences are readable *synchronously* while `webserver/index-inject`
 * renders a page and while `apply` decides whether to run the startup sweep, so
 * the file is read once at construction (it is a few bytes) and only written
 * afterwards. A missing or malformed file keeps the defaults.
 */
class PreferencesStore {
  /**
   * @param file - absolute path of the preference file.
   * @param log - reporter.
   */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    /** @type {{ deleteSessionsEnabled: boolean, splashEnabled: boolean, memoryEnabled: boolean }} */
    this.values = { deleteSessionsEnabled: true, splashEnabled: true, memoryEnabled: true };
    this.writing = Promise.resolve();
    /**
     * Optional hook the Host sets after construction: fired with the new value
     * after a persisted `memoryEnabled` toggle, so the running process can
     * register/release the memory tools without a reload. Assigning nothing
     * keeps the store standalone (tests).
     * @type {((enabled: boolean) => void) | undefined}
     */
    this.onMemoryEnabledChange = undefined;
    this.loadSync();
  }

  /** Read the current preference file; defaults survive any read failure. */
  loadSync() {
    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`preferences unreadable: ${error?.message ?? error}`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.deleteSessionsEnabled === 'boolean') {
        this.values.deleteSessionsEnabled = parsed.deleteSessionsEnabled;
      }
      if (typeof parsed?.splashEnabled === 'boolean') this.values.splashEnabled = parsed.splashEnabled;
      if (typeof parsed?.memoryEnabled === 'boolean') this.values.memoryEnabled = parsed.memoryEnabled;
    } catch {
      this.log('preferences not valid JSON; using defaults');
    }
  }

  /** @returns whether the delete-sessions feature is enabled. */
  get deleteSessionsEnabled() {
    return this.values.deleteSessionsEnabled;
  }

  /** @returns whether the startup animation is enabled. */
  get splashEnabled() {
    return this.values.splashEnabled;
  }

  /** @returns whether the local memory feature is enabled. */
  get memoryEnabled() {
    return this.values.memoryEnabled;
  }

  /**
   * Apply one or both feature switches and persist them.
   * @param patch - fields to change; omitted fields keep their values.
   * @returns the save completion.
   */
  async setFeatures(patch) {
    if (typeof patch?.deleteSessionsEnabled === 'boolean') {
      this.values.deleteSessionsEnabled = patch.deleteSessionsEnabled;
    }
    if (typeof patch?.splashEnabled === 'boolean') {
      this.values.splashEnabled = patch.splashEnabled;
    }
    if (typeof patch?.memoryEnabled === 'boolean') {
      this.values.memoryEnabled = patch.memoryEnabled;
    }
    await this.save();
  }

  /** Persist the current preferences atomically, serialized behind earlier writes. */
  save() {
    const snapshot = {
      version: PREFERENCES_VERSION,
      deleteSessionsEnabled: this.values.deleteSessionsEnabled,
      splashEnabled: this.values.splashEnabled,
      memoryEnabled: this.values.memoryEnabled,
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
        this.log(`could not save preferences: ${error?.message ?? error}`);
      });
    return this.writing;
  }
}

/**
 * Remove the session-log directory of one session.
 *
 * The directory name is the encoded session id under the project key of its
 * working directory, so the sweep looks for a directory with that exact name
 * one level below `sessions/` instead of re-deriving the project key.
 *
 * @param dshHome - harness home.
 * @param id - session id.
 * @returns whether anything was removed.
 */
async function removeSessionLogDirectory(dshHome, id) {
  const sessionsRoot = join(dshHome, 'sessions');
  let removed = false;
  const candidates = [join(sessionsRoot, id)];
  let entries = [];
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    candidates.push(join(sessionsRoot, entry.name, id));
  }
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    await rm(candidate, { recursive: true, force: true, maxRetries: 3 });
    removed = true;
  }
  return removed;
}

/**
 * Remove the projection-cache row of one session.
 * @param dshHome - harness home.
 * @param id - session id.
 * @returns whether anything was removed.
 */
async function removeProjectionCache(dshHome, id) {
  const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions');
  const candidates = [`${id}.json`, `${id}.json.tmp`].map((name) => join(cacheRoot, name));
  let removed = false;
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    await rm(candidate, { force: true });
    removed = true;
  }
  return removed;
}

/**
 * Drop one session id from the workspace registry, through the live storage
 * domain when it is open (its in-memory document is authoritative while the
 * Host runs) and through the JSON file otherwise.
 *
 * @param ctx - host plugin context.
 * @param dshHome - harness home.
 * @param id - session id.
 * @param log - reporter.
 * @returns how the reference was removed: `domain`, `file` or `none`.
 */
async function forgetInWorkspaceRegistry(ctx, dshHome, id, log) {
  const domain = ctx.get('storageDomain')?.get?.(WORKSPACE_DOMAIN);
  if (domain !== undefined) {
    // The open domain owns the document: a raw file edit would be invisible to
    // it and silently republished by its next write.
    let changed = false;
    try {
      const global = domain.global.get();
      if (global !== null && typeof global === 'object') {
        const next = { ...global };
        for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
          const current = next[key];
          if (Array.isArray(current) && current.includes(id)) {
            next[key] = current.filter((value) => value !== id);
            changed = true;
          }
        }
        if (changed) await domain.global.set(next);
      }
      const table = domain.table(WORKSPACES_TABLE);
      for (const [key, value] of table.entries()) {
        const sessionIds = value?.sessionIds;
        if (!Array.isArray(sessionIds) || !sessionIds.includes(id)) continue;
        await table.update(key, (current) => ({
          ...current,
          sessionIds: current.sessionIds.filter((value) => value !== id),
        }));
        changed = true;
      }
    } catch (error) {
      log(`could not update the workspace list: ${error?.message ?? error}`);
      return 'none';
    }
    return changed ? 'domain' : 'none';
  }

  const file = join(dshHome, 'storages', 'workspace.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'none';
    throw error;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`workspace.json is not valid JSON: ${error?.message ?? error}`);
  }
  let changed = false;
  const global = document?.global;
  if (global !== null && typeof global === 'object') {
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      const current = global[key];
      if (!Array.isArray(current) || !current.includes(id)) continue;
      global[key] = current.filter((value) => value !== id);
      changed = true;
    }
  }
  const workspaces = document?.tables?.[WORKSPACES_TABLE];
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const value of Object.values(workspaces)) {
      const sessionIds = value?.sessionIds;
      if (!Array.isArray(sessionIds) || !sessionIds.includes(id)) continue;
      value.sessionIds = sessionIds.filter((candidate) => candidate !== id);
      changed = true;
    }
  }
  if (!changed) return 'none';
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document)}\n`, 'utf8');
  await rename(temporary, file);
  return 'file';
}

/**
 * Whether a session is live in this Host process and must not be deleted.
 *
 * Two fences: a published live session (`ctx.sessions`), and — when the
 * persistence service is present — an existing write owner, which rejects a
 * second `open(id, 'write')`.
 *
 * @param ctx - host plugin context.
 * @param id - session id.
 * @returns `true` when live, `false` when provably not live, `undefined` when
 * the process cannot tell (treated as not live, matching a cold start).
 */
async function isSessionLive(ctx, id) {
  try {
    const sessions = ctx.get('sessions');
    if (sessions !== undefined && sessions.get?.(id) !== undefined) return true;
    const agents = ctx.get('agents');
    if (agents !== undefined && agents.get?.(id) !== undefined) return true;
  } catch {
    /* a missing/refusing service proves nothing; fall through to the probe */
  }
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) return undefined;
  try {
    const handle = await persistence.open(id, 'write');
    await handle.close();
    return false;
  } catch (error) {
    const name = error?.name ?? '';
    const code = error?.code ?? '';
    if (name === 'SessionAlreadyOwnedError' || code === 'session-already-owned') return true;
    return undefined;
  }
}

/**
 * Load the parent → direct-children link table of the logical session corpus.
 *
 * Subagent sessions never appear in the sidebar's session list, so the user
 * cannot mark them — but each log header records its `parentSession`, and the
 * `sessionQuery` service exposes every header of the corpus (live-preferred).
 * The sweep uses this table to take a marked session's subagent tree with it.
 *
 * @param ctx - host plugin context.
 * @param log - reporter.
 * @returns parent id → direct child ids, or `undefined` when the service is
 *   absent or fails (the sweep then behaves exactly like before cascading).
 */
async function loadSubagentChildLinks(ctx, log) {
  const query = ctx.get('sessionQuery');
  if (query === undefined || typeof query.listSessions !== 'function') return undefined;
  let records;
  try {
    records = await query.listSessions();
  } catch (error) {
    log(`subagent cleanup skipped: ${error?.message ?? error}`);
    return undefined;
  }
  if (!Array.isArray(records)) return undefined;
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const record of records) {
    const header = record?.header;
    const parent = header?.parentSession;
    if (!isSafeSessionId(header?.id) || !isSafeSessionId(parent)) continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [header.id]);
    else if (!list.includes(header.id)) list.push(header.id);
  }
  return children;
}

/**
 * Collect the whole descendant tree of one session from a child-link table.
 *
 * Breadth-first over direct-child links; the visited set makes cycles from a
 * corrupted corpus harmless. Self-links are ignored.
 *
 * @param id - root session id (not included in the result).
 * @param children - parent id → direct child ids.
 * @returns descendant ids in discovery order.
 */
function collectDescendantIds(id, children) {
  const found = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child) || child === id) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Print the one-line outcome of a startup sweep.
 *
 * The sweep can touch many sessions, and the panel already shows what the user
 * marked: the terminal only needs the tally. Failures were reported one by one
 * with their reason, so this line carries counts only and leaves zero out.
 *
 * @param log - reporter.
 * @param outcome - per-session buckets from {@link sweepMarkedSessions}.
 * @param counts - the `ignored` / `live` counters the buckets do not carry.
 */
function logSweepSummary(log, outcome, counts) {
  const parts = [];
  if (outcome.purged.length > 0) {
    const subagents = outcome.cascade.length;
    const suffix = subagents > 0 ? ` (+${subagents} subagent${subagents === 1 ? '' : 's'})` : '';
    parts.push(`removed ${outcome.purged.length}${suffix}`);
  }
  if (counts.live > 0) parts.push(`${counts.live} still running`);
  if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`);
  if (counts.ignored > 0) parts.push(`${counts.ignored} ignored`);
  if (parts.length > 0) log(`sessions: ${parts.join(', ')}`);
}

/**
 * Physically delete every marked session that is not live.
 *
 * A marked session that is really deleted takes its subagent sessions with it
 * ({@link loadSubagentChildLinks}, {@link collectDescendantIds}): each
 * descendant goes through the same liveness fence and artifact cleanup as the
 * marked session itself. A live descendant is marked for the next startup; a
 * failed descendant deletion is marked too, riding the same durable retry
 * path as a user-made mark. The user's own marked set is otherwise never
 * inflated: descendants of a live or failed parent stay untouched, and
 * cancelling the parent's mark never deletes its subagents.
 *
 * The mark is kept when a deletion fails, so the next startup retries it.
 *
 * @param options - ctx, harness home, store, reporter.
 * @returns the per-session outcome; `cascade` lists the descendants actually
 *   deleted through their parent.
 */
async function sweepMarkedSessions({ ctx, dshHome, store, log }) {
  const outcome = { purged: [], skipped: [], failed: [], cascade: [] };
  /** Counters the outcome buckets do not carry, for the summary line. */
  const counts = { ignored: 0, live: 0 };
  /** Whether the durable marked set changed, so an idle sweep writes nothing. */
  let changed = false;
  /**
   * Parent → children map, resolved at most once and only when a parent's log
   * was really removed: building it lists the whole session corpus, which is the
   * most expensive step of the sweep and is pure waste when nothing is deleted.
   */
  let children;
  let childrenLoaded = false;
  const childLinks = async () => {
    if (!childrenLoaded) {
      childrenLoaded = true;
      children = await loadSubagentChildLinks(ctx, log);
    }
    return children;
  };
  for (const id of store.list()) {
    if (!isSafeSessionId(id)) {
      counts.ignored += 1;
      if (store.remove(id)) changed = true;
      continue;
    }
    try {
      if ((await isSessionLive(ctx, id)) === true) {
        outcome.skipped.push(id);
        counts.live += 1;
        continue;
      }
      await removeSessionLogDirectory(dshHome, id);
      await removeProjectionCache(dshHome, id);
      await forgetInWorkspaceRegistry(ctx, dshHome, id, log);
      if (store.remove(id)) changed = true;
      outcome.purged.push(id);
      const links = await childLinks();
      if (links === undefined || !links.has(id)) continue;
      for (const child of collectDescendantIds(id, links)) {
        try {
          if ((await isSessionLive(ctx, child)) === true) {
            if (store.add(child)) changed = true;
            outcome.skipped.push(child);
            counts.live += 1;
            continue;
          }
          await removeSessionLogDirectory(dshHome, child);
          await removeProjectionCache(dshHome, child);
          await forgetInWorkspaceRegistry(ctx, dshHome, child, log);
          outcome.cascade.push(child);
        } catch (error) {
          if (store.add(child)) changed = true;
          outcome.failed.push(child);
          log(`could not remove ${child}: ${error?.message ?? error}`);
        }
      }
    } catch (error) {
      outcome.failed.push(id);
      log(`could not remove ${id}: ${error?.message ?? error}`);
    }
  }
  if (changed) await store.save();
  logSweepSummary(log, outcome, counts);
  return outcome;
}

/** Read one JSON request body. */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  if (res.headersSent === true) {
    res.destroy?.();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** The card-facing projection of one skill detail (body dropped). */
function publicSkill(detail) {
  const { markdown, ...entry } = detail;
  return entry;
}

/**
 * Build the request handler for {@link ROUTE_PREFIX}.
 *
 * Routes (all JSON):
 * - `GET  <prefix>/marked` → `{ ok: true, value: { ids } }`
 * - `POST <prefix>/mark`   → marks one session (idempotent)
 * - `POST <prefix>/unmark` → clears one mark (idempotent)
 * - `GET  <prefix>/preferences` → `{ deleteSessionsEnabled, splashEnabled, memoryEnabled }`
 * - `POST <prefix>/preferences` → updates any built-in feature switch (the
 *   switches are rendered by the sidebar Control panel now)
 * - `GET  <prefix>/memory` → `{ ok: true, value: { entries } }` (all entries)
 * - `POST <prefix>/memory`  `{content, type?, source?}` → creates one entry
 * - `PATCH <prefix>/memory/<id>` `{content?, type?, enabled?}` → updates one entry
 * - `DELETE <prefix>/memory/<id>` → removes one entry
 * - `GET  <prefix>/lan/status` → LAN proxy state, saved preferences, detected
 *   addresses (the dsh-lan-access engine, integrated)
 * - `POST <prefix>/lan/preferences` `{lanAccessEnabled?, lanHost?, lanPort?,
 *   lanMaxConnections?}` → saves and applies immediately (the LAN proxy
 *   restarts in this process; `lanMaxConnections: 0` means unlimited)
 * - `GET  <prefix>/skills` → `{ root, entries }` (the managed user skill root)
 * - `GET  <prefix>/skills/<id>` → `{ entry, markdown }` (one SKILL.md)
 * - `PATCH <prefix>/skills/<id>` `{enabled}` → flips `disable-model-invocation`
 * - `DELETE <prefix>/skills/<id>` → removes the bundle or flat file
 * - `POST <prefix>/skills/<id>/reveal` → reveals SKILL.md in the file manager
 * - `POST <prefix>/skills/ensure` → recreates the root and the bundled skill
 *   (one-shot: the install marker keeps a removal permanent)
 * - `POST <prefix>/skills/restore` → puts the bundled skill back when its
 *   directory is missing, ignoring that marker (the Skills page calls it on
 *   every open; an existing copy is never overwritten)
 * - `GET  <prefix>/agent` → `{ path, exists, content }` (the user-global
 *   `<DSH home>/AGENTS.md`)
 * - `POST <prefix>/agent` `{content}` → writes that file; blank content removes
 *   it (`{ path, exists, content, bytes, saved: true }`)
 * - `GET  <prefix>/mcp` → `{ servers }` (the Codex-standard `mcp_servers` list)
 * - `POST <prefix>/mcp` → creates one server (the whole raw object in the body)
 * - `PATCH <prefix>/mcp/<name>` → replaces one server (name change included)
 * - `PATCH <prefix>/mcp/<name>/enabled` `{enabled}` → flips one `enabled` flag
 * - `DELETE <prefix>/mcp/<name>` → removes one server
 * - `GET  <prefix>/restart` → `{ scheduled, remainingMs, deadline,
 *   activeSessions, firedAt, error, dryRun }` (the one-click restart plan)
 * - `POST <prefix>/restart` `{enabled}` → arms the six-second countdown, or
 *   clears it when `enabled` is false; 409 `busy` while a session is running
 *
 * @param options - ctx, delete-session store, preference store, memory store,
 *   LAN facade, the managed skills root, the Harness home the Agent page edits,
 *   the MCP store, the restart controller, and the reporter.
 * @returns the route handler.
 */
function createRouteHandler({ ctx, store, preferences, memory, lan, skillsRoot, agentHome, mcp, bundledMarkerFile, restart, log }) {
  const trusted = (req) => {
    try {
      const connection = ctx.get('connection');
      if (connection === undefined) return true;
      return connection.requestRejection(req) === undefined;
    } catch {
      return true;
    }
  };
  const envelope = (res, status, value, error) => {
    writeJson(res, status, error === undefined ? { ok: true, value } : { ok: false, error });
  };
  /**
   * The clean (token-less) URL this process serves. The page that comes back
   * from a restart navigates here instead of reloading its own address: the old
   * address may carry the previous process's launch token, which the new process
   * rejects, while the session cookie stays valid across restarts.
   */
  const restartStatusValue = (status) => {
    let url = '';
    try {
      const advertised = ctx.get('webApp')?.getAdvertisedUrl?.();
      if (typeof advertised === 'string') url = advertised;
    } catch {
      url = '';
    }
    return { ...status, url };
  };
  return async (req, res) => {
    if (!trusted(req)) {
      envelope(res, 403, undefined, { code: 'forbidden', message: 'forbidden' });
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
    const action = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : '';
    try {
      if (action === 'marked' && req.method === 'GET') {
        envelope(res, 200, { ids: store.list() });
        return;
      }
      if (action === 'memory' && req.method === 'GET') {
        if (memory === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'memory is unavailable' });
          return;
        }
        envelope(res, 200, { entries: memory.list().map(publicEntry) });
        return;
      }
      if (action === 'memory' && req.method === 'POST') {
        if (memory === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'memory is unavailable' });
          return;
        }
        const body = await readJsonBody(req);
        const entry = await memory.create({
          content: body?.content,
          ...(typeof body?.type === 'string' ? { type: body.type } : {}),
          source: 'manual',
        });
        envelope(res, 200, { entry: publicEntry(entry) });
        return;
      }
      {
        const match = action.match(/^memory\/([A-Za-z0-9-]+)$/);
        if (match !== null) {
          const id = match[1];
          const entry = memory?.get(id);
          if (memory === undefined || entry === undefined) {
            envelope(res, 404, undefined, { code: 'not-found', message: `no memory with id ${id}` });
            return;
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req);
            const updated = await memory.update(id, {
              ...(typeof body?.content === 'string' ? { content: body.content } : {}),
              ...(typeof body?.type === 'string' ? { type: body.type } : {}),
              ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            });
            envelope(res, 200, { entry: publicEntry(updated) });
            return;
          }
          if (req.method === 'DELETE') {
            await memory.remove(id);
            envelope(res, 200, { deleted: true, id });
            return;
          }
        }
      }
      if (action === 'preferences') {
        if (preferences === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'preferences are unavailable' });
          return;
        }
        if (req.method === 'GET') {
          envelope(res, 200, {
            deleteSessionsEnabled: preferences.deleteSessionsEnabled,
            splashEnabled: preferences.splashEnabled,
            memoryEnabled: preferences.memoryEnabled,
          });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const hasDelete = typeof body?.deleteSessionsEnabled === 'boolean';
          const hasSplash = typeof body?.splashEnabled === 'boolean';
          const hasMemory = typeof body?.memoryEnabled === 'boolean';
          if (!hasDelete && !hasSplash && !hasMemory) {
            envelope(res, 400, undefined, {
              code: 'bad-preference',
              message: 'provide deleteSessionsEnabled, splashEnabled and/or memoryEnabled as booleans',
            });
            return;
          }
          if (
            (body.deleteSessionsEnabled !== undefined && !hasDelete) ||
            (body.splashEnabled !== undefined && !hasSplash) ||
            (body.memoryEnabled !== undefined && !hasMemory)
          ) {
            envelope(res, 400, undefined, {
              code: 'bad-preference',
              message: 'feature switches must be booleans',
            });
            return;
          }
          const deleteChanged = hasDelete && preferences.deleteSessionsEnabled !== body.deleteSessionsEnabled;
          const splashChanged = hasSplash && preferences.splashEnabled !== body.splashEnabled;
          const memoryChanged = hasMemory && preferences.memoryEnabled !== body.memoryEnabled;
          const changed = deleteChanged || splashChanged || memoryChanged;
          if (changed) await preferences.setFeatures(body);
          // The memory switch is live beyond the flag: the four `memory_*` tool
          // definitions register/release inside the running process right here.
          if (memoryChanged && typeof preferences.onMemoryEnabledChange === 'function') {
            try {
              preferences.onMemoryEnabledChange(body.memoryEnabled === true);
            } catch (error) {
              log(`memory tools failed: ${error?.message ?? error}`);
            }
          }
          envelope(res, 200, {
            deleteSessionsEnabled: preferences.deleteSessionsEnabled,
            splashEnabled: preferences.splashEnabled,
            memoryEnabled: preferences.memoryEnabled,
            changed,
          });
          return;
        }
      }
      if ((action === 'mark' || action === 'unmark') && req.method === 'POST') {
        const body = await readJsonBody(req);
        const sessionId = body?.sessionId;
        if (!isSafeSessionId(sessionId)) {
          envelope(res, 400, undefined, { code: 'bad-session-id', message: 'sessionId is required' });
          return;
        }
        const changed = action === 'mark' ? store.add(sessionId) : store.remove(sessionId);
        if (changed) await store.save();
        envelope(res, 200, { ids: store.list(), changed });
        return;
      }
      if (action === 'lan/status' && req.method === 'GET') {
        if (lan === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the LAN engine is unavailable' });
          return;
        }
        envelope(res, 200, await lan.statusValue());
        return;
      }
      if (action === 'lan/preferences' && req.method === 'POST') {
        if (lan === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the LAN engine is unavailable' });
          return;
        }
        const body = await readJsonBody(req);
        envelope(res, 200, { ...(await lan.applyPreferences(body)), applied: true });
        return;
      }
      // Agent: the user-global instruction file (`<dshHome>/AGENTS.md`).
      if (action === 'agent' && (req.method === 'GET' || req.method === 'POST')) {
        if (agentHome === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the Harness home is unavailable' });
          return;
        }
        if (req.method === 'GET') {
          envelope(res, 200, await readAgentInstructions(agentHome));
          return;
        }
        const body = await readJsonBody(req, MAX_AGENT_BODY_BYTES);
        const saved = await saveAgentInstructions(agentHome, body?.content);
        envelope(res, 200, { ...saved, saved: true });
        return;
      }
      // MCP: the Codex-standard `mcp_servers.<name>` list (mcp.js). The store
      // serializes every mutation; errors carry route-facing codes.
      if (action === 'mcp' && (req.method === 'GET' || req.method === 'POST')) {
        if (mcp === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the MCP engine is unavailable' });
          return;
        }
        if (req.method === 'GET') {
          envelope(res, 200, { servers: (await mcp.list()).map(publicServer) });
          return;
        }
        const body = await readJsonBody(req, MAX_MCP_BODY_BYTES);
        const created = await mcp.create(body);
        envelope(res, 200, { server: publicServer(created), servers: (await mcp.list()).map(publicServer) });
        return;
      }
      {
        const match = action.match(/^mcp\/([A-Za-z0-9_-]{1,32})(\/enabled)?$/);
        if (match !== null && mcp !== undefined) {
          const name = match[1];
          const isEnabled = match[2] === '/enabled';
          if (isEnabled && req.method === 'PATCH') {
            const body = await readJsonBody(req);
            if (typeof body?.enabled !== 'boolean') {
              envelope(res, 400, undefined, { code: 'bad-preference', message: 'enabled must be a boolean' });
              return;
            }
            const server = await mcp.setEnabled(name, body.enabled);
            envelope(res, 200, { server: publicServer(server) });
            return;
          }
          if (!isEnabled && req.method === 'PATCH') {
            const body = await readJsonBody(req, MAX_MCP_BODY_BYTES);
            const server = await mcp.update(name, body);
            envelope(res, 200, { server: publicServer(server) });
            return;
          }
          if (!isEnabled && req.method === 'DELETE') {
            const result = await mcp.remove(name);
            if (!result.removed) {
              envelope(res, 404, undefined, { code: 'not-found', message: `no MCP server named ${name}` });
              return;
            }
            // The disable-sync outcome rides along (`reloaded` / `absent` /
            // `failed` / `restart-required`) so the panel can warn about a
            // composition row it could not turn off.
            envelope(res, 200, {
              removed: true,
              id: name,
              ...(result.applied === undefined ? {} : { applied: result.applied }),
              ...(result.applyError === undefined ? {} : { applyError: result.applyError }),
            });
            return;
          }
        }
      }
      // One-click restart: the card's switch arms a Host-side countdown. The
      // fire path relaunches through a detached helper and asks the launcher for
      // a graceful exit, so the process never kills itself without a successor.
      if (action === 'restart' && req.method === 'GET') {
        if (restart === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the restart engine is unavailable' });
          return;
        }
        envelope(res, 200, restartStatusValue(restart.status()));
        return;
      }
      if (action === 'restart' && req.method === 'POST') {
        if (restart === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the restart engine is unavailable' });
          return;
        }
        const body = await readJsonBody(req);
        if (typeof body?.enabled !== 'boolean') {
          envelope(res, 400, undefined, { code: 'bad-preference', message: 'enabled must be a boolean' });
          return;
        }
        if (!body.enabled) {
          envelope(res, 200, restartStatusValue(restart.cancel()));
          return;
        }
        const planned = restart.schedule();
        if (planned.ok !== true) {
          // A restart must never cut a running session; the panel shows this as
          // 「有会话尚在运行」 instead of an error toast.
          envelope(res, 409, undefined, {
            code: 'busy',
            message: `${planned.status.activeSessions} session(s) are still running`,
          });
          return;
        }
        envelope(res, 200, restartStatusValue(planned.status));
        return;
      }
      // Skills: the managed user root (`<dshHome>/skills`) the Harness scans.
      if (action === 'skills' && req.method === 'GET') {
        if (skillsRoot === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the skills root is unavailable' });
          return;
        }
        await mkdir(skillsRoot, { recursive: true });
        envelope(res, 200, { root: skillsRoot, entries: await listSkills(skillsRoot) });
        return;
      }
      if (action === 'skills/restore' && req.method === 'POST') {
        if (skillsRoot === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the skills root is unavailable' });
          return;
        }
        await mkdir(skillsRoot, { recursive: true });
        const installed = await restoreBundledSkill(
          bundledSkillDirectory(),
          skillsRoot,
          'skill-creator',
          log,
          bundledMarkerFile,
        );
        envelope(res, 200, { root: skillsRoot, installed, entries: await listSkills(skillsRoot) });
        return;
      }
      if (action === 'skills/ensure' && req.method === 'POST') {
        if (skillsRoot === undefined) {
          envelope(res, 503, undefined, { code: 'unavailable', message: 'the skills root is unavailable' });
          return;
        }
        await mkdir(skillsRoot, { recursive: true });
        const installed = await installBundledSkill(
          bundledSkillDirectory(),
          skillsRoot,
          'skill-creator',
          log,
          bundledMarkerFile,
        );
        envelope(res, 200, { root: skillsRoot, installed, entries: await listSkills(skillsRoot) });
        return;
      }
      {
        const match = /^skills\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/reveal)?$/.exec(action);
        if (match !== null && skillsRoot !== undefined) {
          const id = match[1];
          const isReveal = match[2] === '/reveal';
          if (isReveal && req.method === 'POST') {
            const detail = await readSkill(skillsRoot, id);
            if (detail === null) {
              envelope(res, 404, undefined, { code: 'not-found', message: `no skill named ${id}` });
              return;
            }
            envelope(res, 200, { revealed: revealInFileManager(detail.path, log), path: detail.path });
            return;
          }
          if (req.method === 'GET') {
            const detail = await readSkill(skillsRoot, id);
            if (detail === null) {
              envelope(res, 404, undefined, { code: 'not-found', message: `no skill named ${id}` });
              return;
            }
            envelope(res, 200, { entry: publicSkill(detail), markdown: detail.markdown });
            return;
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req);
            if (typeof body?.enabled !== 'boolean') {
              envelope(res, 400, undefined, { code: 'bad-preference', message: 'enabled must be a boolean' });
              return;
            }
            const updated = await setSkillEnabled(skillsRoot, id, body.enabled);
            if (updated === null) {
              envelope(res, 404, undefined, { code: 'not-found', message: `no skill named ${id}` });
              return;
            }
            envelope(res, 200, { entry: publicSkill(updated) });
            return;
          }
          if (req.method === 'DELETE') {
            const removed = await removeSkill(skillsRoot, id);
            if (!removed) {
              envelope(res, 404, undefined, { code: 'not-found', message: `no skill named ${id}` });
              return;
            }
            envelope(res, 200, { removed: true, id });
            return;
          }
        }
      }
      envelope(res, 404, undefined, { code: 'not-found', message: `no route for ${req.method} ${pathname}` });
    } catch (error) {
      // Skills rejections carry their own code: conflicts and bad input are
      // different failures for the panel, so they get different statuses.
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'bad-request';
      const status = code === 'exists' ? 409 : code === 'not-found' ? 404 : code === 'unavailable' ? 503 : 400;
      // A rejected request is already explained in the panel; only a failure
      // the user cannot act on (5xx) belongs in the terminal.
      if (status >= 500) log(`${action} failed: ${error?.message ?? error}`);
      envelope(res, status, undefined, { code, message: String(error?.message ?? error) });
    }
  };
}

/**
 * Drop the deletion mark of a session the user kept talking to.
 *
 * "继续对话" is a durable fact: the Harness appends `user/message` to that
 * session's log whenever the human sends one (composer, queued steering, or any
 * other entry point). The mark is a pending intent, so a real user message
 * cancels it. Every other event is ignored, and the fold is pure so it can be
 * verified without a live Session.
 *
 * @param options - store.
 * @param session - the Session the event was appended to (id is all we need).
 * @param event - the committed SessionEvent.
 * @returns whether a mark was cleared.
 */
function clearMarkOnUserMessage({ store }, session, event) {
  if (event?.type !== 'user/message') return false;
  const id = session?.id;
  if (typeof id !== 'string' || !store.has(id)) return false;
  store.remove(id);
  void store.save();
  return true;
}

/**
 * Reveal one file in the platform file manager (Explorer / Finder / xdg-open).
 * Fire-and-forget: the browser only needs to know the request was accepted.
 * @param target - absolute file path.
 * @param log - reporter.
 * @returns whether a shell was asked to open it.
 */
export function revealInFileManager(target, log) {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log(`could not open the file manager: ${error?.message ?? error}`));
    child.unref();
    return true;
  } catch (error) {
    log(`could not open the file manager: ${error?.message ?? error}`);
    return false;
  }
}

/** Absolute path of the skill bundled with this package. */
export function bundledSkillDirectory() {
  return fileURLToPath(new URL('./skills/skill-creator', import.meta.url));
}

/**
 * Push one MCP server's `enabled` flag into the running Harness composition.
 *
 * The MCP page owns the Codex-standard document (`mcp.json`); a harness or
 * Codex *connection* however comes from a composition entry — the user pasted
 * the generated `@deepseek-ai/dsh-mcp-client` YAML into the profile patch as
 * `id: mcp-<name>`. When such an entry exists, flipping the flag here rewrites
 * that entry's `disabled` through the plugin manager and reloads it, so the
 * panel switch takes effect immediately instead of on the next restart.
 *
 * Outcomes of the bridge (never thrown — the document write already succeeded):
 * - `'reloaded'`: the composition entry was found and reloaded.
 * - `'absent'`: no composition entry with `mcp-<name>` exists (or the plugin
 *   manager is not loaded) — only the document changed, effective next paste/
 *   restart. The expected state for a server that was never wired in.
 * - `'failed'`: the manager rejected the change (protected entry, concurrent
 *   edit, …); the message lands on the record's `applyError` for the panel.
 *
 * @param ctx - owning Cordis context.
 * @param server - the persisted server record (name + enabled).
 * @param log - reporter.
 * @returns `'reloaded'`, `'absent'`, or `'failed'` (rejected with `applyError`).
 */
export async function applyMcpEnabled(ctx, server, log) {
  const entryId = `mcp-${server.name}`;
  const enabled = server.enabled === true;
  let manager;
  try {
    manager = ctx.get('pluginManager');
  } catch {
    manager = undefined;
  }
  if (manager === undefined || typeof manager.setPluginEnabled !== 'function' || typeof manager.listPlugins !== 'function') {
    return 'absent';
  }
  let row;
  try {
    row = (await manager.listPlugins()).find((item) => item.entryId === entryId);
  } catch (error) {
    log(`MCP sync failed: ${error?.message ?? error}`);
    throw new Error(`listing plugins failed: ${error?.message ?? error}`);
  }
  if (row === undefined || row.readOnlyReason !== undefined) {
    if (row !== undefined) log(`MCP ${server.name} not applied: ${row.readOnlyReason}`);
    return 'absent';
  }
  if ((row.enabled ?? true) === enabled) return 'reloaded';
  try {
    const outcome = await manager.setPluginEnabled(entryId, enabled);
    if (outcome?.restartReason !== undefined) {
      log(`MCP ${server.name}: restart needed (${outcome.restartReason})`);
      return 'restart-required';
    }
    return 'reloaded';
  } catch (error) {
    log(`MCP ${server.name} failed: ${error?.message ?? error}`);
    throw error;
  }
}

/**
 * Plugin entry: run the startup sweep, publish the mark endpoints, drop a mark
 * as soon as the user continues talking to that session, and cover the Web UI's
 * boot with the startup animation while the preference allows it. All feature
 * switches render on the sidebar Control panel (Client half).
 * @param ctx - owning Cordis context.
 */
export function apply(ctx) {
  const log = createLog();
  const dshHome = resolveDshHome();
  const store = new DeleteSessionStore(join(dshHome, PLUGIN_NAME, STATE_FILE_NAME), log);
  const preferences = new PreferencesStore(join(dshHome, PLUGIN_NAME, PREFERENCES_FILE_NAME), log);
  const memory = new MemoryStore(join(dshHome, PLUGIN_NAME, MEMORY_FILE_NAME), log);
  const skillsRoot = join(dshHome, SKILLS_DIR_NAME);
  /** Records which bundled skills were installed once, so a removal sticks. */
  const bundledMarkerFile = join(dshHome, PLUGIN_NAME, 'bundled-skills.json');
  /** The Codex-standard MCP server list (Component 7, `mcp.js`). */
  const mcp = new McpStore(join(dshHome, PLUGIN_NAME, MCP_STATE_FILE_NAME), (server) =>
    applyMcpEnabled(ctx, server, log),
  );
  /** Restart log path, shared by this controller and the detached helper. */
  const restartLogPath = join(dshHome, PLUGIN_NAME, RESTART_LOG_NAME);
  /**
   * One-click restart (Component 8, `restart.js`): a Host-side countdown that
   * ends in a graceful launcher shutdown plus a detached relaunch helper.
   *
   * `requestExit` prefers the launcher's own `appExit` service — the same
   * bounded teardown a SIGTERM gets, so sessions, the LAN proxy and the web
   * server close in order. The watchdog is the backstop for a plugin holding a
   * handle open: without it the process would never end, and the helper would
   * eventually start a second instance on the same port.
   */
  const restart = new RestartController({
    delayMs: RESTART_DELAY_MS,
    log,
    logPath: restartLogPath,
    countRunning: () => countRunningSessions(ctx),
    dryRun: process.env.DSH_MIKUFAN_RESTART_DRYRUN === '1',
    requestExit: (code) => {
      let exit;
      try {
        exit = ctx.get('appExit');
      } catch {
        exit = undefined;
      }
      if (typeof exit === 'function') {
        exit(code);
      } else {
        // No `appExit` (a non-launcher embedding): the dsh launcher installs
        // SIGTERM/SIGINT handlers that dispose the tree and then exit.
        process.emit('SIGTERM');
      }
      setTimeout(() => process.exit(code), RESTART_SHUTDOWN_WATCHDOG_MS).unref?.();
    },
    relaunch: () => relaunchDsh({ logPath: restartLogPath }),
  });
  ctx.effect(() => () => restart.dispose(), `${PLUGIN_NAME}: restart countdown`);
  void memory.load();
  log(
    `ready: delete-sessions ${preferences.deleteSessionsEnabled ? 'on' : 'off'}, ` +
      `startup-animation ${preferences.splashEnabled ? 'on' : 'off'}, ` +
      `memory ${preferences.memoryEnabled ? 'on' : 'off'}`,
  );

  // Skills: the Harness ships no skills folder. Create the user root the
  // provider scans (`<dshHome>/skills`) and install the bundled skill-creator
  // once; the marker file makes a later removal permanent.
  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      try {
        await ensureSkillsRoot(dshHome);
        if (disposed) return;
        await installBundledSkill(
          bundledSkillDirectory(),
          skillsRoot,
          'skill-creator',
          log,
          bundledMarkerFile,
        );
      } catch (error) {
        log(`skills setup failed: ${error?.message ?? error}`);
      }
    })();
    return () => {
      disposed = true;
    };
  }, `${PLUGIN_NAME}: skills root`);

  // The agent's memory tools: registered only while the feature is on. The
  // registration waits for the `tools` service through `inject`: a plain
  // effect that reads `ctx.get('tools')` races service construction — when
  // this plugin loads before dsh-tools, the read returns `undefined` and the
  // effect never re-runs, so the tools silently never register. `inject`
  // starts the body only once the service is available, the same way the web
  // routes below wait for `webServer`. The definitions are plain
  // registry-ready ToolDefinition objects whose shapes were verified against
  // dsh-tools' published types (`parameters` = the JSON Schema object,
  // `output.schema` inside the enforced JsonSchemaNode subset), so no harness
  // import is needed and the registration cannot fail on module resolution.
  //
  // The dashboard switch stays live: the store exposes `onMemoryEnabledChange`
  // and the preferences route fires it after every persisted toggle, so the
  // tool set is registered and disposed within the running process without a
  // reload (the route also touches a module-scoped disposer for the pre-route
  // window, because the route handler is created before the inject body runs).
  /** Disposer for the tool set, owned by whichever effect last registered it. */
  let memoryToolsDispose = null;
  const registerOrReleaseMemoryTools = (enabled) => {
    if (enabled && memoryToolsDispose === null) {
      const disposers = createMemoryTools(memory).map((definition) => {
        try {
          return ctx.get('tools')?.register(definition);
        } catch {
          return undefined;
        }
      });
      memoryToolsDispose = () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* a lost race with plugin teardown: the disposer is already dead */
          }
        }
      };
    } else if (!enabled && memoryToolsDispose !== null) {
      const dispose = memoryToolsDispose;
      memoryToolsDispose = null;
      dispose();
    }
  };
  preferences.onMemoryEnabledChange = (enabled) => {
    registerOrReleaseMemoryTools(enabled === true);
  };
  ctx.inject(['tools'], (scoped) => {
    if (preferences.memoryEnabled !== true) return undefined;
    memoryToolsDispose = null; // the inject body owns the lifecycle now
    const disposers = createMemoryTools(memory).map((definition) => scoped.tools.register(definition));
    memoryToolsDispose = () => {
      for (const dispose of disposers) dispose();
    };
    return () => {
      if (memoryToolsDispose !== null) {
        const dispose = memoryToolsDispose;
        memoryToolsDispose = null;
        dispose();
      }
    };
  });

  // The prompt index: a runtime context that renders the enabled entries at
  // every assembly, or nothing while the store is empty / the feature is off.
  // Also waits for its service through `inject` — same race as above: an
  // effect reading `ctx.get('systemPrompt')` before the service exists would
  // read `undefined` and never re-run, so the index would never attach.
  ctx.inject(['systemPrompt'], (scoped) => {
    return scoped.systemPrompt.context({
      name: 'dsh-mikufan:memory-index',
      order: 150,
      text: () => {
        if (preferences.memoryEnabled !== true) return '';
        return memory.indexText();
      },
    });
  });

  // The cover belongs in the served index.html, before the app module runs. The
  // preference is read per render, so toggling it applies on the next page load
  // without restarting the Host.
  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (table) => {
        table.push(...splashIndexInjections(preferences.splashEnabled === true));
      }),
    `${PLUGIN_NAME}: startup animation cover`,
  );

  ctx.effect(() => {
    let disposed = false;
    /** Pending deferred sweep, cleared when the plugin unloads. */
    let timer = null;
    // Claim the one sweep of this process before any await, so a reload racing
    // the boot cannot run it twice.
    const claimed = globalThis[STARTUP_SWEEP_CLAIM] !== true;
    if (claimed) globalThis[STARTUP_SWEEP_CLAIM] = true;
    /** Delete the marked sessions once the boot burst is over. */
    const sweep = async () => {
      timer = null;
      if (disposed) return;
      try {
        await sweepMarkedSessions({ ctx, dshHome, store, log });
      } catch (error) {
        log(`startup sweep failed: ${error?.message ?? error}`);
      }
    };
    void (async () => {
      await store.load();
      if (disposed) return;
      if (!claimed) return;
      if (preferences.deleteSessionsEnabled !== true) {
        const pending = store.list().length;
        if (pending > 0) log(`${pending} marked session(s) pending (delete-sessions off)`);
        return;
      }
      // Nothing marked: the sweep would only list the corpus, write the same
      // file back and print nothing, so it never starts.
      if (store.list().length === 0) return;
      // The listing scales with the user's history; run it just after the boot
      // burst instead of competing with it. An earlier exit retries next start.
      timer = setTimeout(() => void sweep(), SWEEP_DELAY_MS);
      timer.unref?.();
    })();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, `${PLUGIN_NAME}: startup sweep`);

  // A continued conversation cancels the pending deletion, whoever started it.
  ctx.effect(
    () => ctx.on('session/event', (session, event) => clearMarkOnUserMessage({ store }, session, event)),
    `${PLUGIN_NAME}: continued-conversation release`,
  );

  ctx.inject(['webServer'], (scoped) => {
    // The LAN engine (integrated from the superseded dsh-lan-access bundle):
    // the proxy binds once the main listener exists, so the upstream port is
    // known. Disposal stops it — an HMR reload restarts it cleanly. The saved
    // preferences migrate from the standalone bundle's file when present.
    const lanPreferencesFile = join(dshHome, PLUGIN_NAME, LAN_PREFERENCES_FILE_NAME);
    const lanLegacyPreferencesFile = join(dshHome, 'dsh-lan-access', 'preferences.json');
    const lanProxy = new LanProxy(log);
    /**
     * Whether the switch was turned on during this Host process. It always
     * starts false, so a stored "on" from the previous session cannot bring
     * the proxy up on boot; the panel turns it on explicitly.
     */
    let lanSwitchOnThisRun = false;
    /** Upstream facts from the main webserver. */
    const lanUpstream = () => {
      const host = typeof scoped.webServer.host === 'string' && scoped.webServer.host !== '' ? scoped.webServer.host : '127.0.0.1';
      const port = typeof scoped.webServer.port === 'number' ? scoped.webServer.port : 3080;
      return { host, port };
    };
    /** Token-URL provider for the proxy's session minting. */
    const lanTokenUrlProvider = () => {
      try {
        const { host, port } = lanUpstream();
        const connection = ctx.get('connection');
        if (typeof connection?.authenticatedUrl !== 'function') return undefined;
        return connection.authenticatedUrl(`http://${urlHost(host)}:${port}/`);
      } catch {
        return undefined;
      }
    };
    /** Start or stop the LAN proxy from the saved preferences. */
    const lanApply = async () => {
      const saved = await readLanPreferences(lanPreferencesFile, lanLegacyPreferencesFile);
      if (!effectiveLanAccessEnabled(saved, lanSwitchOnThisRun)) {
        // Silently idle saves: only a listener that really was up reports the stop.
        const wasRunning = lanProxy.running;
        await lanProxy.stop();
        if (wasRunning) log('LAN off');
        return saved;
      }
      const { host, port } = lanUpstream();
      await lanProxy.start({
        lanHost: saved.lanHost,
        lanPort: saved.lanPort,
        maxConnections: saved.lanMaxConnections,
        upstreamHost: host,
        upstreamPort: port,
        tokenUrlProvider: lanTokenUrlProvider,
      });
      return saved;
    };
    /** Current LAN facts for the status endpoint. */
    const lanStatusValue = async () => {
      const saved = await readLanPreferences(lanPreferencesFile, lanLegacyPreferencesFile);
      const { host, port } = lanUpstream();
      return {
        saved: {
          ...saved,
          lanAccessEnabled: effectiveLanAccessEnabled(saved, lanSwitchOnThisRun),
        },
        proxy: {
          running: lanProxy.running,
          maxConnections: lanProxy.maxConnections,
          connections: lanProxy.connections,
          devices: lanProxy.devices,
          ...(lanProxy.running
            ? { host: lanProxy.host, port: lanProxy.port, lanUrl: lanProxy.lanUrl, upstream: lanProxy.upstreamAuthority }
            : {}),
          ...(lanProxy.error !== undefined ? { error: lanProxy.error } : {}),
        },
        detected: detectPrivateIpv4List(),
        defaultPort: LAN_DEFAULT_PORT,
        defaultMaxConnections: LAN_DEFAULT_MAX_CONNECTIONS,
        maxConnectionsLimit: LAN_MAX_CONNECTIONS_LIMIT,
        upstream: `${urlHost(host)}:${port}`,
      };
    };
    /**
     * Save one LAN preference patch (validated) and apply it immediately.
     * The whole read → merge → save → restart chain runs serialized: two cards
     * posting in the same second must not resurrect an older snapshot or race
     * two listener restarts.
     */
    const lanSaveApplyLocked = async (body) => {
      const hasSwitch = typeof body?.lanAccessEnabled === 'boolean';
      const hasHost = body?.lanHost !== undefined;
      const hasPort = body?.lanPort !== undefined;
      const hasMax = body?.lanMaxConnections !== undefined;
      if (!hasSwitch && !hasHost && !hasPort && !hasMax) {
        const error = new Error('provide lanAccessEnabled, lanHost, lanPort and/or lanMaxConnections');
        error.code = 'bad-preference';
        throw error;
      }
      const current = await readLanPreferences(lanPreferencesFile, lanLegacyPreferencesFile);
      const next = { ...current };
      if (hasHost) {
        const cleaned = cleanLanHost(body.lanHost);
        if (cleaned === null) {
          const error = new Error('lanHost must be empty (auto-detect) or a concrete IPv4/IPv6 address; wildcard addresses are not allowed');
          error.code = 'bad-host';
          throw error;
        }
        next.lanHost = cleaned;
      }
      if (hasPort) {
        const cleanedPort = cleanLanPort(body.lanPort);
        if (cleanedPort === null) {
          const error = new Error('lanPort must be an integer between 1 and 65535');
          error.code = 'bad-port';
          throw error;
        }
        next.lanPort = cleanedPort;
      }
      if (hasMax) {
        const cleanedMax = cleanLanMaxConnections(body.lanMaxConnections);
        if (cleanedMax === null) {
          const error = new Error(`lanMaxConnections must be an integer between 0 and ${LAN_MAX_CONNECTIONS_LIMIT} (0 = unlimited)`);
          error.code = 'bad-max-connections';
          throw error;
        }
        next.lanMaxConnections = cleanedMax;
      }
      if (hasSwitch) {
        next.lanAccessEnabled = body.lanAccessEnabled;
        lanSwitchOnThisRun = next.lanAccessEnabled === true;
      }
      await saveLanPreferences(lanPreferencesFile, next);
      await lanApply();
      return lanStatusValue();
    };
    /** Serializes {@link lanSaveApplyLocked}; a failed save does not poison the queue. */
    let lanSaveQueue = Promise.resolve();
    const lanSaveApply = (body) => {
      const run = lanSaveQueue.then(() => lanSaveApplyLocked(body));
      lanSaveQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    // The LAN facade consumed by the route handler.
    const lan = { statusValue: lanStatusValue, applyPreferences: lanSaveApply };

    scoped.effect(
      () => {
        void (async () => {
          // Every Host start begins with the switch off; a stored "on" from
          // the previous session is persisted back to off instead of being
          // resumed. The user turns it on from the control panel when needed.
          // The reset is an internal correction: by design the LAN feature is
          // off at every start, so the startup prints nothing about it.
          lanSwitchOnThisRun = false;
          try {
            await resetLanAccessOnStartup(lanPreferencesFile, lanLegacyPreferencesFile, log);
          } catch (error) {
            log(`LAN reset failed: ${error?.message ?? error}`);
          }
        })();
        return () => {
          void lanProxy.stop();
        };
      },
      `${PLUGIN_NAME}: LAN proxy`,
    );
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: SPLASH_ROUTE,
          handler: createSplashRouteHandler({ ctx, log }),
        }),
      `${PLUGIN_NAME}: ${SPLASH_ROUTE} route`,
    );
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: createRouteHandler({ ctx, store, preferences, memory, lan, skillsRoot, agentHome: dshHome, mcp, bundledMarkerFile, restart, log }),
        }),
      `${PLUGIN_NAME}: ${ROUTE_PREFIX} routes`,
    );
  });
}

/** Test surface: the sweep, the stores, the routes and the splash asset. */
export const __internal = {
  DeleteSessionStore,
  PreferencesStore,
  MemoryStore,
  createMemoryTools,
  similarity,
  queryTerms,
  publicEntry,
  sweepMarkedSessions,
  loadSubagentChildLinks,
  collectDescendantIds,
  removeSessionLogDirectory,
  removeProjectionCache,
  forgetInWorkspaceRegistry,
  clearMarkOnUserMessage,
  createRouteHandler,
  createSplashRouteHandler,
  splashIndexInjections,
  readSplashAsset,
  RestartController,
  countRunningSessions,
  relaunchDsh,
  resolveDshHome,
  isSafeSessionId,
  revealInFileManager,
  bundledSkillDirectory,
  splash: __splashInternal,
  skills: {
    ensureSkillsRoot,
    installBundledSkill,
    listSkills,
    readSkill,
    removeSkill,
    setSkillEnabled,
  },
  lan: {
    LanProxy,
    cleanLanHost,
    cleanLanMaxConnections,
    cleanLanPort,
    clearDetectedAddresses,
    detectPrivateIpv4List,
    effectiveLanAccessEnabled,
    isWildcardAddress,
    LAN_DEFAULT_MAX_CONNECTIONS,
    LAN_MAX_CONNECTIONS_LIMIT,
    readLanPreferences,
    resetLanAccessOnStartup,
    saveLanPreferences,
    urlHost,
  },
  mcp: {
    MAX_MCP_SERVERS,
    McpStore,
    applyMcpEnabled,
    normalizeMcpServer,
    publicServer,
    readMcpServers,
    writeMcpServers,
  },
};
