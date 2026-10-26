/**
 * dsh-mikufan — MCP servers engine.
 *
 * The Control panel's MCP page manages the JSON equivalent of Codex's
 * `mcp_servers.<name>` tables from `~/.codex/config.toml` (the OpenAI
 * ChatGPT/Codex standard, shared by the ChatGPT desktop app, the Codex CLI and
 * the IDE extension). The Harness's own `@deepseek-ai/dsh-mcp-client` plugin
 * accepts the same transports as entries of its `cordis.yml` patch — this
 * engine only writes and validates the configuration file, so an entry here
 * can be transcribed into either consumer.
 *
 * Storage model (mirrors `agent.js` / the LAN preferences):
 * - one document `~/.dsh/mikufan/mcp.json` (`{ version, servers: [...] }`)
 * - every write is temp-file + rename (the shared atomic-write idiom)
 * - a write serializes behind the previous one, so two cards saving in the
 *   same second cannot resurrect an older snapshot
 *
 * Validation follows the Codex configuration contract field by field:
 * - server name: the `[mcp_servers.<name>]` table key; constrained to
 *   `[A-Za-z0-9_-]{1,32}` so it works unchanged as `@deepseek-ai/dsh-mcp-client`'s
 *   `serverName` and inside `mcp__<serverName>__<tool>` names
 * - `transport: 'stdio'` → `command` (required), optional `args`, `env`,
 *   `env_vars`, `cwd`
 * - `transport: 'streamable_http'` → `url` (required, http(s)), optional
 *   `bearer_token_env_var` (a name, never a token), `http_headers`
 * - both: optional `startup_timeout_sec`, `tool_timeout_sec`, `enabled`
 *   (the standard's default is true)
 *
 * @module dsh-mikufan/mcp
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File name of the MCP server document under the plugin state directory. */
export const MCP_FILE_NAME = 'mcp.json';
/** Document schema version. */
export const MCP_VERSION = 1;
/** Largest accepted JSON document, in UTF-8 bytes (a 512 KiB agent body of servers). */
export const MAX_MCP_BODY_BYTES = 512 * 1024;
/** Largest number of servers one document may hold. */
export const MAX_MCP_SERVERS = 64;
/**
 * Valid server name: the Codex `[mcp_servers.<name>]` key, kept inside the
 * `@deepseek-ai/dsh-mcp-client` `serverName` budget so a direct transcription
 * is always possible.
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Transports the Codex standard defines. */
export const MCP_TRANSPORTS = ['stdio', 'streamable_http'];
/** Largest accepted `startup_timeout_sec` (the standard defaults to 10). */
export const MCP_STARTUP_TIMEOUT_DEFAULT = 10;
/** Largest accepted `tool_timeout_sec` (the standard defaults to 60). */
export const MCP_TOOL_TIMEOUT_DEFAULT = 60;
/** Ceiling for both timeout fields: five minutes, like the standard's samples. */
export const MCP_TIMEOUT_LIMIT = 600;

/** Absolute path of the MCP document inside the plugin state directory. */
export function mcpFilePath(stateDir) {
  return join(stateDir, MCP_FILE_NAME);
}

/** Build one engine error carrying the route-facing code. */
function mcpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Keep a record's `updatedAt` stamp when the incoming value carries one. The
 * panel orders its cards newest-first on this field, so every read → mutate →
 * write round trip has to preserve the stamps of the servers it did not touch
 * (`normalizeMcpServer` rebuilds each record from scratch otherwise).
 *
 * @param server - the rebuilt record.
 * @param raw - the incoming `updatedAt`, if any.
 * @returns the record, with the stamp when it was usable.
 */
function keepUpdatedAt(server, raw) {
  if (typeof raw !== 'string') return server;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return server;
  return { ...server, updatedAt: new Date(at).toISOString() };
}

/**
 * Validate one server object against the Codex `mcp_servers.<name>` contract.
 *
 * Accepts any object shape (the panel keeps the raw form state), returns the
 * normalized record with only known fields. Field names match the Codex
 * configuration exactly — `env_vars` is the *forward list* (names of ambient
 * variables to hand to the server), `env` is the copied key/value table, and
 * `bearer_token_env_var` holds a variable name, never a token value.
 *
 * @param name - the server key.
 * @param value - the raw server object.
 * @returns the normalized server record.
 */
export function normalizeMcpServer(name, value) {
  if (typeof name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(name)) {
    throw mcpError(
      'bad-name',
      'server name must match [A-Za-z0-9_-]{1,32} (the Codex [mcp_servers.<name>] key)',
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw mcpError('bad-server', `server ${name} must be an object`);
  }
  const transport = value.transport;
  if (transport !== 'stdio' && transport !== 'streamable_http') {
    throw mcpError('bad-transport', `server ${name}: transport must be "stdio" or "streamable_http"`);
  }
  /** Positive finite seconds or `undefined`. */
  const timeout = (field, raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > MCP_TIMEOUT_LIMIT) {
      throw mcpError('bad-timeout', `server ${name}: ${field} must be between 0 and ${MCP_TIMEOUT_LIMIT} seconds`);
    }
    return raw;
  };
  /** String list with every entry a clean nonempty name. */
  const nameList = (field, raw) => {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw mcpError('bad-list', `server ${name}: ${field} must be a list of nonempty strings`);
    }
    const names = raw.map((item) => item.trim());
    return names.length > 0 ? names : undefined;
  };
  /** String/string dictionary without empty keys. */
  const table = (field, raw) => {
    if (raw === undefined || raw === null) return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw mcpError('bad-table', `server ${name}: ${field} must be an object of string values`);
    }
    const entries = Object.entries(raw);
    if (entries.some(([key, item]) => typeof key !== 'string' || key.trim() === '' || typeof item !== 'string')) {
      throw mcpError('bad-table', `server ${name}: ${field} must map nonempty keys to strings`);
    }
    return entries.length > 0 ? Object.fromEntries(entries.map(([key, item]) => [key.trim(), item])) : undefined;
  };
  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw mcpError('bad-command', `server ${name}: stdio requires a command`);
    }
    const server = {
      name,
      transport,
      command: value.command.trim(),
    };
    const args = nameList('args', value.args);
    if (args !== undefined) server.args = args;
    const env = table('env', value.env);
    if (env !== undefined) server.env = env;
    const envVars = nameList('env_vars', value.env_vars);
    if (envVars !== undefined) server.env_vars = envVars;
    if (typeof value.cwd === 'string' && value.cwd.trim() !== '') server.cwd = value.cwd.trim();
    const startup = timeout('startup_timeout_sec', value.startup_timeout_sec);
    if (startup !== undefined) server.startup_timeout_sec = startup;
    const tool = timeout('tool_timeout_sec', value.tool_timeout_sec);
    if (tool !== undefined) server.tool_timeout_sec = tool;
    server.enabled = value.enabled === false ? false : true;
    return keepUpdatedAt(server, value.updatedAt);
  }
  if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url.trim())) {
    throw mcpError('bad-url', `server ${name}: streamable_http requires an http(s) url`);
  }
  const server = {
    name,
    transport,
    url: value.url.trim(),
  };
  if (value.bearer_token_env_var !== undefined && value.bearer_token_env_var !== null && value.bearer_token_env_var !== '') {
    if (typeof value.bearer_token_env_var !== 'string' || value.bearer_token_env_var.trim() === '') {
      throw mcpError('bad-env-var', `server ${name}: bearer_token_env_var must be an environment variable name`);
    }
    server.bearer_token_env_var = value.bearer_token_env_var.trim();
  }
  const headers = table('http_headers', value.http_headers);
  if (headers !== undefined) server.http_headers = headers;
  const startup = timeout('startup_timeout_sec', value.startup_timeout_sec);
  if (startup !== undefined) server.startup_timeout_sec = startup;
  const tool = timeout('tool_timeout_sec', value.tool_timeout_sec);
  if (tool !== undefined) server.tool_timeout_sec = tool;
  server.enabled = value.enabled === false ? false : true;
  return keepUpdatedAt(server, value.updatedAt);
}

/**
 * The list projection the panel renders: no secret-adjacent doubt — the
 * document only ever stores the *name* of a token environment variable, so the
 * projection is the record itself. The `applied` outcome (whether the running
 * composition followed the `enabled` flag) and its `applyError` pass through;
 * the engine-internal sync fields do not exist on disk at all.
 */
function publicServer(server) {
  return { ...server };
}

/**
 * Load and parse the MCP document. A missing file is the empty state; a
 * malformed document surfaces as `unavailable` instead of resetting the file.
 *
 * @param file - absolute `mcp.json` path.
 * @returns `{ servers }` (an empty list when the file does not exist yet).
 */
export async function readMcpServers(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { servers: [] };
    throw mcpError('unavailable', `cannot read ${file}: ${error?.message ?? error}`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw mcpError('unavailable', `${file} is not valid JSON`);
  }
  const servers = Array.isArray(document?.servers) ? document.servers : [];
  const list = [];
  for (const entry of servers) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw mcpError('unavailable', `${file} holds a server entry that is not an object`);
    }
    list.push(normalizeMcpServer(entry.name, entry));
  }
  return { servers: list };
}

/**
 * Write the whole document through a temp file + rename, creating the state
 * directory when needed.
 *
 * @param file - absolute `mcp.json` path.
 * @param servers - the already-normalized server list.
 */
export async function writeMcpServers(file, servers) {
  const document = JSON.stringify({ version: MCP_VERSION, servers }, null, 2) + '\n';
  try {
    await mkdir(join(file, '..'), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, document, 'utf8');
    await rename(temp, file);
  } catch (error) {
    throw mcpError('unavailable', `cannot write ${file}: ${error?.message ?? error}`);
  }
}

/**
 * Create the engine over one document path. Every mutation re-reads the file,
 * so an out-of-band edit is adopted instead of clobbered; the write queue
 * keeps concurrent panel requests ordered. Each mutation also stamps the
 * touched record's `updatedAt`: the panel orders its cards newest-first on it.
 *
 * `applyEnabled` (optional) runs after a successful document write that changed
 * a server's `enabled` flag (setEnabled / update / remove / create). The Host
 * passes the plugin-manager bridge here so an existing harness composition
 * entry (`mcp-<name>`) is reloaded in the same breath — see `index.js`. It
 * receives the already-persisted server record; its own failures are collected
 * on the returned record (`applyError`), never fail the document write.
 */
export class McpStore {
  /** @param file - absolute `mcp.json` path. */
  constructor(file, applyEnabled) {
    this.file = file;
    this.applyEnabled = typeof applyEnabled === 'function' ? applyEnabled : null;
    /** Serializes the read → mutate → write chain of every mutation. */
    this.queue = Promise.resolve();
  }

  /** Run the enabled-sync bridge and attach its outcome to the record. */
  async syncEnabled(server) {
    if (this.applyEnabled === null) return server;
    try {
      const applied = await this.applyEnabled(server);
      if (applied === undefined || applied === null) return { ...server, applied: 'absent' };
      return { ...server, applied: applied === true ? 'reloaded' : applied };
    } catch (error) {
      return { ...server, applied: 'failed', applyError: String(error?.message ?? error) };
    }
  }

  /** The current list, straight from disk. */
  async list() {
    return (await readMcpServers(this.file)).servers;
  }

  /** Run one mutation behind the store queue; failures do not poison it. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Create a server from a raw panel object. Duplicate names are rejected —
   * they would collide in `[mcp_servers.<name>]` and as `serverName`. A created
   * server that is born disabled (or enabled) syncs the composition entry too.
   */
  async create(value) {
    return this.enqueue(async () => {
      const existing = await readMcpServers(this.file);
      const server = { ...normalizeMcpServer(value?.name, value), updatedAt: new Date().toISOString() };
      if (existing.servers.some((entry) => entry.name === server.name)) {
        throw mcpError('exists', `an MCP server named ${server.name} already exists`);
      }
      const servers = [...existing.servers, server];
      if (servers.length > MAX_MCP_SERVERS) {
        throw mcpError('too-many', `at most ${MAX_MCP_SERVERS} MCP servers are supported`);
      }
      await writeMcpServers(this.file, servers);
      return this.syncEnabled(server);
    });
  }

  /** Replace one server wholesale (the panel's edit dialog). */
  async update(name, value) {
    return this.enqueue(async () => {
      const existing = await readMcpServers(this.file);
      const index = existing.servers.findIndex((entry) => entry.name === name);
      if (index === -1) throw mcpError('not-found', `no MCP server named ${name}`);
      const server = { ...normalizeMcpServer(value?.name, value), updatedAt: new Date().toISOString() };
      if (server.name !== name && existing.servers.some((entry) => entry.name === server.name)) {
        throw mcpError('exists', `an MCP server named ${server.name} already exists`);
      }
      const previous = existing.servers[index];
      const servers = [...existing.servers];
      servers[index] = server;
      await writeMcpServers(this.file, servers);
      // The composition row only follows the flag; a rename or field edit does
      // not reload the harness entry (its config is the user's pasted YAML).
      return server.enabled === (previous?.enabled === true)
        ? server
        : this.syncEnabled(server);
    });
  }

  /** Flip one server's `enabled` flag in place and sync the composition entry. */
  async setEnabled(name, enabled) {
    return this.enqueue(async () => {
      const existing = await readMcpServers(this.file);
      const index = existing.servers.findIndex((entry) => entry.name === name);
      if (index === -1) throw mcpError('not-found', `no MCP server named ${name}`);
      const next = enabled === true;
      const servers = [...existing.servers];
      servers[index] = { ...servers[index], enabled: next, updatedAt: new Date().toISOString() };
      await writeMcpServers(this.file, servers);
      return this.syncEnabled(servers[index]);
    });
  }

  /**
   * Remove one server; a removed server's composition entry is disabled.
   *
   * @returns `{ removed, applied?, applyError? }` — `removed: false` when the
   * document had no such server. The enable-sync outcome travels with the
   * result because the row it disables outlives the record: the panel has to
   * be able to say that the leftover `mcp-<name>` entry could not be turned
   * off, exactly like `create` / `update` / `setEnabled` report theirs.
   */
  async remove(name) {
    return this.enqueue(async () => {
      const existing = await readMcpServers(this.file);
      const index = existing.servers.findIndex((entry) => entry.name === name);
      if (index === -1) return { removed: false };
      const removed = existing.servers[index];
      const servers = existing.servers.filter((entry) => entry.name !== name);
      await writeMcpServers(this.file, servers);
      if (!removed.enabled) return { removed: true };
      const synced = await this.syncEnabled({ ...removed, enabled: false });
      return {
        removed: true,
        ...(synced.applied === undefined ? {} : { applied: synced.applied }),
        ...(synced.applyError === undefined ? {} : { applyError: synced.applyError }),
      };
    });
  }
}

export { publicServer };
