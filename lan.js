/**
 * dsh-mikufan — LAN access engine (Host half).
 *
 * A second, no-token entry for the Harness Web GUI, integrated from the
 * former standalone `dsh-lan-access` bundle (superseded). The shipped
 * webserver row is NOT touched: the main listener keeps its loopback bind
 * (127.0.0.1:3080) and its token login. This module owns a SECOND, separate
 * listener — the LAN proxy — that a user turns on manually from the Control
 * panel's 局域网访问 page:
 *
 * - Address: a concrete LAN IPv4/IPv6 of this machine (auto-detected by
 *   default, virtual adapters skipped) — selectable in the panel.
 * - Port: default 3090, freely configurable.
 * - Max connections: 0 (unlimited) by default; a positive cap counts distinct
 *   devices (peer addresses) connected right now and answers a new device over
 *   the cap with a raw 503, never forwarding its requests upstream.
 * - No token: the proxy holds the loopback session cookie itself. Every LAN
 *   request is forwarded to the loopback listener with `Host`/`Origin`
 *   rewritten to the loopback authority and the proxy's cookie injected, so
 *   the browser trust fence and authentication see a local, already-logged-in
 *   client. The cookie never reaches the LAN client. WebSocket upgrades and
 *   streaming responses (SSE) are tunneled unchanged.
 *
 * Preferences live in `<DSH home>/dsh-mikufan/lan-preferences.json`; a
 * machine upgraded from the standalone bundle keeps its settings through the
 * legacy read-through (`<DSH home>/dsh-lan-access/preferences.json`).
 *
 * SECURITY (deliberate, user opt-in): the LAN endpoint authenticates nobody —
 * anyone on the network reaching `http://<ip>:<port>` controls this Harness.
 * Only sensible on a trusted network.
 *
 * @module dsh-mikufan/lan
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

/** LAN preference file name, under `<DSH home>/dsh-mikufan/`. */
export const LAN_PREFERENCES_FILE_NAME = 'lan-preferences.json';
/** LAN preference file schema version. */
export const LAN_PREFERENCES_VERSION = 1;
/** Default LAN proxy port. */
export const LAN_DEFAULT_PORT = 3090;
/** Default cap on concurrent LAN connections (`0` = unlimited). */
export const LAN_DEFAULT_MAX_CONNECTIONS = 0;
/** Highest accepted connection cap. */
export const LAN_MAX_CONNECTIONS_LIMIT = 256;
/** Adapter names that never carry the home LAN (virtual machines, tunnels…). */
const VIRTUAL_INTERFACE = /vethernet|wsl|docker|vmware|virtualbox|hyper-v|loopback|vbox|qemu|libvirt|tailscale|zerotier|\btap\b|\btun\b/i;
/**
 * How long a detected address list stays valid.
 *
 * `os.networkInterfaces()` costs about 5 ms on Windows and the panel asks for it
 * on every LAN status read and every save; adapters do not change at that pace.
 */
const DETECT_CACHE_MS = 5_000;
/** Last detection: `{ at, list }`, or null when nothing is cached. */
let detectCache = null;

/**
 * Whether an address literal requests every interface at once (never bind it).
 * @param host - candidate address literal.
 * @returns true for IPv4 any, IPv6 any, and their IPv4-mapped forms.
 */
export function isWildcardAddress(host) {
  return host === '0.0.0.0' || host === '::' || host.endsWith(':0.0.0.0');
}

/**
 * All private IPv4 addresses of this machine, virtual adapters skipped.
 *
 * @param options - `{ fresh: true }` bypasses the short cache (binding a
 *   listener must see an adapter that was plugged in a moment ago).
 * @returns address literals, home-router ranges (192.168) first; a copy, so a
 *   caller cannot mutate the cache.
 */
export function detectPrivateIpv4List({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && detectCache !== null && now - detectCache.at < DETECT_CACHE_MS) return [...detectCache.list];
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      const octet = address.address.split('.').map(Number);
      if (octet.length !== 4 || octet.some((value) => !Number.isInteger(value))) continue;
      const priv =
        octet[0] === 10 ||
        (octet[0] === 192 && octet[1] === 168) ||
        (octet[0] === 172 && octet[1] >= 16 && octet[1] <= 31);
      if (priv) found.push(address.address);
    }
  }
  const rank = (address) => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  found.sort((left, right) => rank(left) - rank(right));
  const list = [...new Set(found)];
  detectCache = { at: now, list };
  return [...list];
}

/** Drop the cached detection (tests, and a forced re-detect). */
export function clearDetectedAddresses() {
  detectCache = null;
}

/**
 * Validate a caller-supplied LAN host.
 * @param value - candidate string; empty means "auto-detect".
 * @returns the cleaned value, or null when invalid.
 */
export function cleanLanHost(value) {
  const wanted = typeof value === 'string' ? value.trim() : '';
  if (wanted === '') return '';
  const family = net.isIP(wanted);
  if ((family === 4 || family === 6) && !isWildcardAddress(wanted)) return wanted;
  return null;
}

/**
 * Validate a caller-supplied LAN port.
 * @param value - candidate port.
 * @returns the cleaned integer, or null when invalid.
 */
export function cleanLanPort(value) {
  const port = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Validate a caller-supplied cap on concurrent LAN connections.
 * @param value - candidate count; 0 means unlimited.
 * @returns the cleaned integer, or null when invalid.
 */
export function cleanLanMaxConnections(value) {
  const count = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 0 || count > LAN_MAX_CONNECTIONS_LIMIT) return null;
  return count;
}

/** The default LAN preference set. */
function defaultLanPreferences() {
  return {
    lanAccessEnabled: false,
    lanHost: '',
    lanPort: LAN_DEFAULT_PORT,
    lanMaxConnections: LAN_DEFAULT_MAX_CONNECTIONS,
  };
}

/**
 * Read the LAN preference file; any failure yields defaults. When the file is
 * absent and `legacyFile` is given, the legacy standalone-bundle file is read
 * through, so an upgrade from dsh-lan-access keeps the user's settings.
 * @param file - absolute path of the LAN preference file.
 * @param legacyFile - absolute path of the former dsh-lan-access preference file.
 * @returns the preference values.
 */
export async function readLanPreferences(file, legacyFile) {
  const parse = (text) => {
    const parsed = JSON.parse(text);
    return {
      lanAccessEnabled: parsed?.lanAccessEnabled === true,
      lanHost: typeof parsed?.lanHost === 'string' ? parsed.lanHost : '',
      lanPort: cleanLanPort(parsed?.lanPort) ?? LAN_DEFAULT_PORT,
      // Absent in files written before the cap existed: unlimited.
      lanMaxConnections: cleanLanMaxConnections(parsed?.lanMaxConnections) ?? LAN_DEFAULT_MAX_CONNECTIONS,
    };
  };
  try {
    return parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') return defaultLanPreferences();
  }
  if (typeof legacyFile === 'string' && legacyFile !== '') {
    try {
      return parse(await readFile(legacyFile, 'utf8'));
    } catch {
      return defaultLanPreferences();
    }
  }
  return defaultLanPreferences();
}

/** Per-file write chains: concurrent saves never share a temp name. */
const lanWriteChains = new Map();
/** Unique suffix for one temp file. */
let lanTempSeq = 0;

/** Write one preference snapshot atomically. */
async function writeLanPreferences(file, prefs) {
  const snapshot = {
    version: LAN_PREFERENCES_VERSION,
    lanAccessEnabled: prefs.lanAccessEnabled,
    lanHost: prefs.lanHost,
    lanPort: prefs.lanPort,
    lanMaxConnections: prefs.lanMaxConnections ?? LAN_DEFAULT_MAX_CONNECTIONS,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(file), { recursive: true });
  lanTempSeq += 1;
  const temporary = `${file}.${process.pid}.${lanTempSeq}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/**
 * Persist the LAN preferences atomically (temp file + rename), serialized per
 * file, so overlapping saves cannot interleave.
 *
 * Saving is a routine panel action the page already reflects, so it prints
 * nothing: the terminal reports the listener's state ({@link LanProxy}).
 *
 * @param file - absolute path of the LAN preference file.
 * @param prefs - the full next preference values.
 */
export function saveLanPreferences(file, prefs) {
  const previous = lanWriteChains.get(file) ?? Promise.resolve();
  const next = previous.then(() => writeLanPreferences(file, prefs));
  lanWriteChains.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * The effective switch for this Host process: a stored "on" only counts when
 * the user turned it on in this run, so every dsh start begins off.
 * @param saved - the stored preference values.
 * @param switchOnThisRun - whether the panel turned the switch on since boot.
 * @returns whether the LAN proxy should be considered on.
 */
export function effectiveLanAccessEnabled(saved, switchOnThisRun) {
  return saved?.lanAccessEnabled === true && switchOnThisRun === true;
}

/**
 * Enforce the per-startup switch policy: a new Host process never starts the
 * LAN proxy. When the stored switch is on from the previous session, persist it
 * off so the panel switch and the status endpoint agree from the first read.
 * The reset is an internal correction and prints nothing: the LAN feature is
 * off by design at every Host start, so startup has no LAN news to report.
 * @param file - absolute path of the LAN preference file.
 * @param legacyFile - absolute path of the former dsh-lan-access preference file.
 * @param log - reporter accepted for call compatibility; never invoked here.
 * @returns the effective preferences for this startup.
 */
export async function resetLanAccessOnStartup(file, legacyFile, log) {
  const saved = await readLanPreferences(file, legacyFile);
  if (saved.lanAccessEnabled !== true) return saved;
  const next = { ...saved, lanAccessEnabled: false };
  await saveLanPreferences(file, next);
  return next;
}

/**
 * URL host form of an address: IPv6 literals get bracketed.
 * @param host - address literal.
 * @returns the host as it appears in a URL.
 */
export function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Normalize a peer address for device counting: IPv4-mapped IPv6 collapses to
 * the plain IPv4 literal, so one phone cannot look like two devices.
 * @param value - `socket.remoteAddress`.
 * @returns the address key.
 */
export function peerAddress(value) {
  const text = typeof value === 'string' && value !== '' ? value : 'unknown';
  return text.startsWith('::ffff:') ? text.slice(7) : text;
}

/**
 * Raw 503 written to a socket that arrives from a new device while the device
 * cap is full. It is emitted from the `connection` handler, so it carries the
 * whole response itself; the socket is tagged so the request path can drop
 * anything that was already buffered.
 */
const MAX_DEVICES_RESPONSE = (() => {
  const body = JSON.stringify({
    ok: false,
    error: { code: 'too-many-devices', message: 'the LAN access device limit is reached' },
  });
  return [
    'HTTP/1.1 503 Service Unavailable',
    'content-type: application/json; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    '',
    body,
  ].join('\r\n');
})();

/**
 * The LAN reverse proxy: one `node:http` server bound to a LAN address that
 * forwards everything to the loopback Harness listener, rewriting the trust
 * headers and injecting its own upstream session cookie. WebSocket upgrades
 * are tunneled; responses stream unchanged.
 */
export class LanProxy {
  /** @param log - reporter. */
  constructor(log) {
    this.log = log;
    /** @type {http.Server | null} */
    this.server = null;
    /** Bound LAN address and port (as configured). */
    this.host = undefined;
    this.port = undefined;
    /** Loopback authority the proxy forwards to, e.g. `127.0.0.1:3080`. */
    this.upstreamAuthority = undefined;
    /** Upstream origin used for rewritten Origin headers. */
    this.upstreamOrigin = undefined;
    /** Launch-token URL provider (Host connection service). */
    this.tokenUrlProvider = undefined;
    /** Proxy-held upstream session: `{ name, value }`. */
    this.session = null;
    /** Session mint in flight (shared by concurrent requests). */
    this.minting = null;
    /** Last listen or runtime error, for the status endpoint. */
    this.error = undefined;
    /** Cap on concurrently connected devices, counted by peer address (0 = unlimited). */
    this.maxConnections = 0;
    /** Distinct peer addresses connected right now. */
    this.devices = 0;
    /** Live TCP connections currently held by the LAN listener. */
    this.connections = 0;
    /** Peer address → live socket count. */
    this.peers = new Map();
    /** Restart counter: socket releases from an older listener are ignored. */
    this.generation = 0;
  }

  /**
   * Start (or restart) the listener.
   * @param options - lanHost ('' = auto-detect), lanPort, maxConnections
   *   (0 = unlimited; counted per device address), upstream facts, and the
   *   token-URL provider for session minting.
   * @returns whether the listener bound successfully.
   */
  start({ lanHost, lanPort, maxConnections = 0, upstreamHost, upstreamPort, tokenUrlProvider }) {
    return new Promise((resolveStart) => {
      const host = lanHost === '' || lanHost === undefined ? detectPrivateIpv4List({ fresh: true })[0] : lanHost;
      if (host === undefined || host === '') {
        this.error = 'no LAN IPv4 address detected; pick one manually in the settings';
        this.log(`LAN error: ${this.error}`);
        resolveStart(false);
        return;
      }
      // The panel saves whenever a field loses focus, and every save restarts
      // the listener. Report only a listener that really came up or moved, so
      // an idle save stays silent in the terminal.
      const previous = this.running ? { host: this.host, port: this.port } : null;
      void this.stop().then(() => {
        this.generation += 1;
        this.host = host;
        this.port = lanPort;
        this.maxConnections = Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : 0;
        this.devices = 0;
        this.connections = 0;
        this.peers = new Map();
        this.upstreamAuthority = `${urlHost(upstreamHost)}:${upstreamPort}`;
        this.upstreamOrigin = `http://${this.upstreamAuthority}`;
        this.tokenUrlProvider = tokenUrlProvider;
        this.session = null;
        this.error = undefined;
        const server = http.createServer((req, res) => this.forwardRequest(req, res, 0));
        server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
        server.on('connection', (socket) => this.admitConnection(socket));
        server.on('error', (error) => {
          this.error =
            error?.code === 'EADDRINUSE'
              ? `port ${this.port} is already in use`
              : String(error?.message ?? error);
          this.log(`LAN error: ${this.error}`);
          try {
            server.close();
          } catch {}
          if (this.server === server) this.server = null;
          resolveStart(false);
        });
        this.server = server;
        server.listen(lanPort, host, () => {
          // The bound port (a configured 0 in tests) is what a browser opens.
          const bound = server.address()?.port ?? lanPort;
          if (previous === null || previous.host !== host || previous.port !== lanPort) {
            this.log(`LAN on: http://${urlHost(host)}:${bound}`);
          }
          resolveStart(true);
        });
      });
    });
  }

  /** Stop the listener and drop the held session. @returns the stop completion. */
  stop() {
    const server = this.server;
    this.server = null;
    this.error = undefined;
    if (server === null) return Promise.resolve();
    return new Promise((resolveStop) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolveStop();
        }
      };
      server.close(() => done());
      server.closeAllConnections?.();
      this.connections = 0;
      this.devices = 0;
      this.peers = new Map();
      setTimeout(done, 2000).unref();
    });
  }

  /** @returns whether the listener is currently bound. */
  get running() {
    return this.server !== null && this.server.listening === true;
  }

  /**
   * Admit or reject one TCP connection. The cap counts DEVICES: distinct peer
   * addresses connected right now, so one phone holding keep-alive, SSE and
   * WebSocket sockets still uses one slot. A new address over the cap is tagged
   * and answered with a raw 503; the request path bails out for it, so nothing
   * is forwarded upstream.
   * @param socket - the freshly accepted socket.
   */
  admitConnection(socket) {
    const address = peerAddress(socket.remoteAddress);
    const live = this.peers.get(address) ?? 0;
    if (this.maxConnections > 0 && live === 0 && this.peers.size >= this.maxConnections) {
      socket.__lanRejected = true;
      socket.on('error', () => {});
      try {
        // Flush the 503, then close the read side too so the parser cannot
        // dispatch a request that is already buffered.
        socket.end(MAX_DEVICES_RESPONSE, () => socket.destroy());
        setTimeout(() => socket.destroy(), 1000).unref?.();
      } catch {
        socket.destroy();
      }
      return;
    }
    this.peers.set(address, live + 1);
    this.connections += 1;
    this.devices = this.peers.size;
    const generation = this.generation;
    let counted = true;
    // 'close' always follows once the socket is gone; releasing on 'error' too
    // would free the slot while the socket is still open.
    socket.on('close', () => {
      if (!counted) return;
      counted = false;
      if (generation !== this.generation) return;
      this.connections = Math.max(0, this.connections - 1);
      const remaining = (this.peers.get(address) ?? 1) - 1;
      if (remaining <= 0) this.peers.delete(address);
      else this.peers.set(address, remaining);
      this.devices = this.peers.size;
    });
    socket.on('error', () => {});
  }

  /** @returns the LAN URL when running, else undefined. */
  get lanUrl() {
    return this.running ? `http://${urlHost(this.host)}:${this.port}` : undefined;
  }

  /**
   * Obtain (or refresh) the upstream session cookie by exchanging the
   * process launch token on the loopback listener. Concurrent callers share
   * one mint. The token URL is built once per start; the process token is
   * stable for the process lifetime.
   */
  mintSession() {
    if (this.minting !== null) return this.minting;
    this.minting = (async () => {
      const tokenUrl = this.tokenUrlProvider?.();
      if (typeof tokenUrl !== 'string' || tokenUrl === '') throw new Error('launch token unavailable');
      const response = await new Promise((resolveMint, rejectMint) => {
        const request = http.request(
          tokenUrl,
          { method: 'GET', headers: { accept: 'text/html' } },
          (upstreamResponse) => resolveMint(upstreamResponse),
        );
        request.on('error', rejectMint);
        request.end();
      });
      // Consume the (303) body so the socket is released.
      response.resume();
      const setCookie = response.headers['set-cookie']?.[0];
      if (typeof setCookie !== 'string') throw new Error(`token exchange failed (HTTP ${response.statusCode})`);
      const pair = setCookie.split(';', 1)[0];
      const equals = pair.indexOf('=');
      if (equals <= 0) throw new Error('token exchange returned no session cookie');
      this.session = { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() };
    })()
      .catch((error) => {
        this.session = null;
        throw error;
      })
      .finally(() => {
        this.minting = null;
      });
    return this.minting;
  }

  /**
   * Build the upstream request headers: loopback authority for Host, the same
   * authority for Origin, the proxy's session cookie, and hop-by-hop headers
   * removed. The LAN client's cookie is dropped: the proxy's session wins.
   * @param sourceHeaders - the LAN client's request headers.
   * @returns headers for the upstream request.
   */
  upstreamHeaders(sourceHeaders) {
    const headers = {};
    for (const [name, value] of Object.entries(sourceHeaders)) {
      if (
        name === 'cookie' ||
        name === 'origin' ||
        name === 'referer' ||
        name === 'connection' ||
        name === 'keep-alive' ||
        name === 'proxy-connection' ||
        name === 'transfer-encoding' ||
        name === 'upgrade'
      ) {
        continue;
      }
      headers[name] = value;
    }
    headers.host = this.upstreamAuthority;
    headers.origin = this.upstreamOrigin;
    if (this.session !== null) headers.cookie = `${this.session.name}=${this.session.value}`;
    return headers;
  }

  /**
   * The upstream address parts for `http.request`.
   * @returns `{ host, port }` with IPv6 literals unbracketed.
   */
  upstreamAddress() {
    const withoutPort = this.upstreamAuthority ?? '127.0.0.1:3080';
    const bracketed = withoutPort.startsWith('[');
    if (bracketed) {
      const close = withoutPort.indexOf(']');
      return { host: withoutPort.slice(1, close), port: Number(withoutPort.slice(close + 2)) };
    }
    const colon = withoutPort.lastIndexOf(':');
    return { host: withoutPort.slice(0, colon), port: Number(withoutPort.slice(colon + 1)) };
  }

  /**
   * Forward one request. On an upstream 401 the session is minted once and
   * body-less requests are retried.
   * @param req - LAN client request.
   * @param res - LAN client response sink.
   * @param attempt - retry count (0 = first try).
   */
  forwardRequest(req, res, attempt) {
    // A connection over the cap was already answered with 503; its buffered
    // request must not reach the upstream listener.
    if (req.socket?.__lanRejected === true) {
      req.socket.destroy();
      return;
    }
    const headers = this.upstreamHeaders(req.headers);
    const upstreamRequest = http.request(
      {
        host: this.upstreamAddress().host,
        port: this.upstreamAddress().port,
        method: req.method,
        path: req.url ?? '/',
        headers,
      },
      (upstreamResponse) => {
        if (upstreamResponse.statusCode === 401 && attempt === 0) {
          upstreamResponse.resume();
          void this.mintSession()
            .then(() => {
              const bodyless = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
              if (bodyless) {
                this.forwardRequest(req, res, 1);
                return;
              }
              writeLanEnvelope(res, 503, undefined, { code: 'upstream-auth', message: 'session refreshed; please retry' });
            })
            .catch((error) => {
              this.log(`LAN sign-in failed: ${error?.message ?? error}`);
              writeLanEnvelope(res, 502, undefined, { code: 'upstream-auth', message: 'could not authenticate to the Harness listener' });
            });
          return;
        }
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders['set-cookie'];
        delete responseHeaders.connection;
        delete responseHeaders['keep-alive'];
        delete responseHeaders['transfer-encoding'];
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
      },
    );
    upstreamRequest.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeLanEnvelope(res, 502, undefined, {
        code: 'upstream-unreachable',
        message: `the Harness listener is unreachable: ${error?.message ?? error}`,
      });
    });
    req.pipe(upstreamRequest);
    // A client abort must not keep the upstream request alive.
    req.on('aborted', () => upstreamRequest.destroy());
  }

  /**
   * Tunnel one WebSocket upgrade: rewrite the handshake like a normal
   * request, then pipe both directions raw.
   * @param req - upgrade request.
   * @param socket - LAN client socket.
   * @param head - first buffered packet.
   */
  handleUpgrade(req, socket, head) {
    if (req.socket?.__lanRejected === true) {
      socket.destroy();
      return;
    }
    void (async () => {
      if (this.session === null) {
        try {
          await this.mintSession();
        } catch (error) {
          this.log(`LAN sign-in failed: ${error?.message ?? error}`);
          socket.destroy();
          return;
        }
      }
      const headers = this.upstreamHeaders(req.headers);
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade ?? 'websocket';
      const upstreamRequest = http.request({
        host: this.upstreamAddress().host,
        port: this.upstreamAddress().port,
        method: req.method,
        path: req.url ?? '/',
        headers,
      });
      upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        const lines = [
          `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`,
        ];
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (name === 'connection' || name === 'upgrade' || name === 'transfer-encoding') continue;
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
        }
        lines.push('connection: Upgrade', `upgrade: ${upstreamResponse.headers.upgrade ?? 'websocket'}`, '', '');
        socket.write(lines.join('\r\n'));
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        const closeBoth = () => {
          upstreamSocket.destroy();
          socket.destroy();
        };
        upstreamSocket.on('error', closeBoth);
        socket.on('error', closeBoth);
        upstreamSocket.on('close', closeBoth);
        socket.on('close', closeBoth);
      });
      upstreamRequest.on('response', (upstreamResponse) => {
        // Upstream refused the upgrade: relay the refusal and close.
        const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 500} ${upstreamResponse.statusMessage ?? ''}`];
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
        }
        lines.push('', '');
        socket.end(lines.join('\r\n'));
        upstreamResponse.resume();
      });
      upstreamRequest.on('error', () => socket.destroy());
      if (head.length > 0) upstreamRequest.write(head);
      upstreamRequest.end();
    })();
  }
}

/** Write one JSON response for a LAN-client-facing error. */
function writeLanEnvelope(res, status, value, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(error === undefined ? { ok: true, value } : { ok: false, error }));
}
