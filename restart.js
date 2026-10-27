/**
 * dsh-mikufan — One-click restart engine.
 *
 * The Control panel's 一键重启 card arms a six-second countdown on the Host; the
 * countdown belongs to this process, not to the page, so closing the panel or
 * reloading the browser keeps the plan. Turning the card's switch off clears the
 * timer again.
 *
 * Firing is a two-part move, because a process cannot restart itself:
 *
 * 1. spawn a detached relaunch helper (`relaunch.mjs`) that waits for this pid
 *    to disappear and then starts the exact same command line again
 *    (`process.execPath process.argv[1] …process.argv.slice(2)`, same cwd and
 *    environment);
 * 2. ask the launcher for a graceful shutdown — the `appExit` service the dsh
 *    launcher provides (`provideCmdline(hostCtx, { exit })`) disposes the whole
 *    application tree before the process ends, so session logs, the LAN listener
 *    and the web server all close in order.
 *
 * A relaunch that cannot be spawned aborts the restart instead of killing the
 * process: a running DSH without its replacement is worse than a failed plan.
 * The same guard runs again at fire time for the "a session started meanwhile"
 * case — a restart is never allowed to cut a running session.
 *
 * @module dsh-mikufan/restart
 */
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Countdown before the process restarts. */
export const RESTART_DELAY_MS = 6000;
/** The detached helper that brings DSH back after this process exits. */
export const RELAUNCH_SCRIPT_NAME = 'relaunch.mjs';
/** Log file of every restart attempt, under the plugin's state directory. */
export const RESTART_LOG_NAME = 'restart.log';
/** The log is rotated to `.1` once it grows past this size, on the next plan. */
export const RESTART_LOG_LIMIT_BYTES = 2 * 1024 * 1024;
/** How long the shutdown may take before the process is forced out. */
export const RESTART_SHUTDOWN_WATCHDOG_MS = 5000;

/** Route-facing error with the code the panel switches on. */
function restartError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Absolute path of the relaunch helper shipped beside this module. */
export function relaunchScriptPath() {
  return fileURLToPath(new URL(`./${RELAUNCH_SCRIPT_NAME}`, import.meta.url));
}

/**
 * How many sessions are running right now.
 *
 * `agents.list()` is process-wide (a session in another window counts too) and
 * includes subagent sessions, which is the strict reading of "有会话尚在运行".
 * A missing or refusing `agents` service reports zero: the restart card must
 * stay usable on a composition without the agent service.
 *
 * @param ctx - host plugin context.
 * @returns the number of agents whose public status is `running`.
 */
export function countRunningSessions(ctx) {
  try {
    const list = ctx?.get?.('agents')?.list?.();
    if (!Array.isArray(list)) return 0;
    return list.filter((agent) => agent?.status === 'running').length;
  } catch {
    return 0;
  }
}

/** Append one timestamped line to the restart log; failures stay silent. */
async function note(file, line) {
  if (typeof file !== 'string' || file === '') return;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* logging must never break the restart path */
  }
}

/** Rotate the restart log once it grows too large (best effort, never fatal). */
async function rotateLog(file) {
  if (typeof file !== 'string' || file === '') return;
  try {
    const info = await stat(file);
    if (info.size <= RESTART_LOG_LIMIT_BYTES) return;
    await rename(file, `${file}.1`);
  } catch {
    /* a missing or locked log simply keeps growing */
  }
}

/**
 * Spawn the detached relaunch helper for this very process.
 *
 * The helper receives one JSON argument (no shell, no quoting): the pid to wait
 * for, the cwd to restore, the log file, and the exact command line to start.
 *
 * `--no-open` is appended unless the original command already had it: the
 * restarted `dsh web` would otherwise open a browser tab of its own, next to the
 * page that is already waiting to come back (that tab also carries a token for
 * the new process, which is a surprise, not a convenience).
 *
 * @param options - entry script, extra args, cwd, log path and spawn/node overrides.
 * @returns the helper's pid, or `null` when the platform did not report one.
 * @throws when the running DSH entry script is unknown or the spawn fails.
 */
export function relaunchDsh(options = {}) {
  const {
    nodePath = process.execPath,
    scriptPath = relaunchScriptPath(),
    entry = process.argv[1],
    args = process.argv.slice(2),
    cwd = process.cwd(),
    logPath = '',
    pid = process.pid,
    env = process.env,
    spawn = spawnProcess,
    quietStart = true,
  } = options;
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw restartError('relaunch-failed', 'the running DSH entry script is unknown');
  }
  const commandArgs = [...args];
  if (quietStart === true && !commandArgs.includes('--no-open')) commandArgs.push('--no-open');
  const payload = { pid, cwd, log: logPath, command: nodePath, args: [entry, ...commandArgs] };
  const child = spawn(nodePath, [scriptPath, JSON.stringify(payload)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref?.();
  return child.pid ?? null;
}

/**
 * The countdown machine. Every collaborator is injected so the engine is
 * exercised without a real timer, process or exit.
 *
 * @param options.delayMs - countdown length.
 * @param options.log - reporter (the Host console).
 * @param options.logPath - restart.log path, or '' to skip file logging.
 * @param options.countRunning - running-session probe.
 * @param options.requestExit - graceful process exit with a code.
 * @param options.relaunch - spawns the detached helper, returns its pid.
 * @param options.dryRun - log the fire and stop there (development switch).
 * @param options.now - clock.
 * @param options.setTimer / options.clearTimer - timer implementation.
 * @param options.bootId - this process's identity, so the page can tell the
 *   restarted Host from the one that is still shutting down.
 */
export class RestartController {
  constructor(options = {}) {
    const {
      delayMs = RESTART_DELAY_MS,
      log = () => {},
      logPath = '',
      countRunning = () => 0,
      requestExit = () => {},
      relaunch = () => relaunchDsh({ logPath }),
      dryRun = false,
      now = () => Date.now(),
      setTimer = (callback, delay) => setTimeout(callback, delay),
      clearTimer = (handle) => clearTimeout(handle),
      bootId = randomUUID(),
    } = options;
    this.delayMs = delayMs;
    this.log = log;
    this.logPath = logPath;
    this.countRunning = countRunning;
    this.requestExit = requestExit;
    this.relaunch = relaunch;
    this.dryRun = dryRun === true;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** Identity of this process; a page reloads only when it changes. */
    this.bootId = bootId;
    /** Unix ms of the planned restart, 0 when nothing is planned. */
    this.deadline = 0;
    /** Pending timer handle, or null. */
    this.handle = null;
    /** ISO instant of the last fire, '' when none happened. */
    this.firedAt = '';
    /** Last failure code (`busy` / `relaunch-failed`), or null. */
    this.error = null;
    /** A fire is in flight (between the timer and the exit request). */
    this.firing = false;
  }

  /** Running sessions, never throwing. @returns the count. */
  running() {
    try {
      const value = this.countRunning();
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  /** The state the panel renders. @returns `{ scheduled, remainingMs, … }`. */
  status() {
    const scheduled = this.deadline !== 0;
    return {
      scheduled,
      remainingMs: scheduled ? Math.max(0, this.deadline - this.now()) : 0,
      deadline: scheduled ? new Date(this.deadline).toISOString() : '',
      activeSessions: this.running(),
      firedAt: this.firedAt,
      error: this.error,
      dryRun: this.dryRun,
      /** Process identity: the page reloads only once this value changes. */
      bootId: this.bootId,
    };
  }

  /**
   * Plan one restart. Idempotent: an existing plan keeps its deadline.
   *
   * @returns `{ ok: true, status }`, or `{ ok: false, code: 'busy', status }`
   *   when a session is running.
   */
  schedule() {
    if (this.deadline !== 0) return { ok: true, status: this.status() };
    if (this.running() > 0) {
      this.error = 'busy';
      return { ok: false, code: 'busy', status: this.status() };
    }
    this.error = null;
    this.firedAt = '';
    this.deadline = this.now() + this.delayMs;
    this.handle = this.setTimer(() => this.fire(), this.delayMs);
    this.log(`restart in ${Math.round(this.delayMs / 1000)}s`);
    void rotateLog(this.logPath);
    void note(this.logPath, `restart planned (pid ${process.pid}, ${this.delayMs}ms)`);
    return { ok: true, status: this.status() };
  }

  /** Drop the plan (the card's switch went off). Idempotent. */
  cancel() {
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    if (this.deadline === 0) return this.status();
    this.deadline = 0;
    this.log('restart cancelled');
    void note(this.logPath, 'restart cancelled');
    return this.status();
  }

  /** Timer callback: re-check, relaunch, then ask for the graceful exit. */
  fire() {
    this.handle = null;
    this.deadline = 0;
    if (this.firing) return;
    this.firing = true;
    try {
      const active = this.running();
      if (active > 0) {
        this.error = 'busy';
        this.log(`restart cancelled: ${active} session(s) still running`);
        void note(this.logPath, `restart cancelled: ${active} session(s) running`);
        return;
      }
      if (this.dryRun) {
        this.error = null;
        this.firedAt = new Date(this.now()).toISOString();
        this.log('restart dry run; nothing happened');
        void note(this.logPath, 'restart dry run (no relaunch, no exit)');
        return;
      }
      let helperPid = null;
      try {
        helperPid = this.relaunch();
      } catch (error) {
        this.error = 'relaunch-failed';
        this.log(`restart aborted: ${error?.message ?? error}`);
        void note(this.logPath, `relaunch helper failed: ${error?.message ?? error}`);
        return;
      }
      this.error = null;
      this.firedAt = new Date(this.now()).toISOString();
      this.log(`restarting (helper ${helperPid ?? 'unknown'})`);
      void note(this.logPath, `relaunch helper pid ${helperPid ?? 'unknown'}; exiting`);
      try {
        this.requestExit(0);
      } catch (error) {
        this.log(`exit failed: ${error?.message ?? error}; forcing exit`);
        void note(this.logPath, `exit request failed: ${error?.message ?? error}`);
        setTimeout(() => process.exit(0), 1000).unref?.();
      }
    } finally {
      this.firing = false;
    }
  }

  /** Drop any pending timer (plugin dispose / HMR reload). */
  dispose() {
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    this.deadline = 0;
  }
}

export { note as appendRestartLog };
