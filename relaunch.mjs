#!/usr/bin/env node
/**
 * dsh-mikufan — detached relaunch helper.
 *
 * Spawned (detached, no console) by `restart.js` a moment before the running
 * DSH asks the launcher for a graceful exit. A process cannot restart itself, so
 * this helper owns the "after" half:
 *
 * 1. wait until the old pid is gone (the port and the state directory are
 *    released by then, or are about to be);
 * 2. give the OS a moment to finish closing the listeners;
 * 3. start the exact command line again, detached, with its output appended to
 *    `restart.log` — and retry a few times if the new process dies immediately
 *    (a lost race for the port, a transient failure).
 *
 * Usage: `node relaunch.mjs '<json>'` where the JSON carries
 * `{ pid, cwd, log, command, args }`. The single JSON argument keeps this free
 * of shell quoting rules on Windows.
 *
 * @module dsh-mikufan/relaunch
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/** How often the old pid is probed. */
const ALIVE_POLL_MS = 150;
/** Give up waiting for the old process after this long. */
const PID_WAIT_TIMEOUT_MS = 90_000;
/** Rest before starting the replacement, so listeners are provably closed. */
const SETTLE_MS = 1000;
/** Start attempts before the helper gives up. */
const ATTEMPTS = 3;
/** A replacement that is still alive after this long counts as started. */
const ATTEMPT_TIMEOUT_MS = 6000;
/** Rest between attempts. */
const BACKOFF_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Append one timestamped line to the log file; never throws. */
async function note(file, line) {
  if (typeof file !== 'string' || file === '') return;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* the restart itself must still run without a log */
  }
}

/** @returns whether the pid still exists (EPERM counts as alive). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Wait until `pid` exits. @returns whether it is gone. */
async function waitForExit(pid, deadline) {
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(ALIVE_POLL_MS);
  }
  return true;
}

/**
 * Watch one spawned replacement for a moment.
 *
 * @returns `{ state: 'alive' }` when it survived the window, or
 *   `{ state: 'exited', code, signal }` when it ended first.
 */
function watch(child, windowMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ state: 'alive' });
    }, windowMs);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ state: 'exited', code, signal });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ state: 'exited', code: null, signal: null, error });
    });
  });
}

/** Start one replacement with its output appended to the log. */
async function startOnce({ command, args, cwd, log }) {
  let handle = null;
  if (log !== '') {
    // The log lives under the plugin state directory, which the Host normally
    // created already; a fresh install may not have it yet.
    try {
      await mkdir(dirname(log), { recursive: true });
      handle = await open(log, 'a');
    } catch {
      handle = null;
    }
  }
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: handle === null ? 'ignore' : ['ignore', handle.fd, handle.fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  const outcome = await watch(child, ATTEMPT_TIMEOUT_MS);
  await handle?.close().catch(() => {});
  return { child, outcome };
}

async function main() {
  const raw = process.argv[2];
  if (typeof raw !== 'string' || raw === '') {
    process.stderr.write('relaunch: missing the JSON argument\n');
    return 2;
  }
  let options;
  try {
    options = JSON.parse(raw);
  } catch {
    process.stderr.write('relaunch: the JSON argument is not valid JSON\n');
    return 2;
  }
  const pid = Number(options?.pid);
  const cwd = typeof options?.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const log = typeof options?.log === 'string' ? options.log : '';
  const command = typeof options?.command === 'string' && options.command !== '' ? options.command : process.execPath;
  const args = Array.isArray(options?.args) ? options.args.map((item) => String(item)) : [];
  if (!Number.isInteger(pid) || pid <= 0 || args.length === 0) {
    await note(log, 'relaunch helper aborted: incomplete payload');
    process.stderr.write('relaunch: the payload needs a pid and the command line to start\n');
    return 2;
  }

  await note(log, `relaunch helper started (waiting for pid ${pid})`);
  if (isAlive(pid) && (await waitForExit(pid, Date.now() + PID_WAIT_TIMEOUT_MS)) === false) {
    await note(log, `relaunch helper aborted: pid ${pid} did not exit in time`);
    return 1;
  }
  await note(log, `pid ${pid} is gone; waiting ${SETTLE_MS}ms before the restart`);
  await sleep(SETTLE_MS);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await note(log, `attempt ${attempt}/${ATTEMPTS}: ${command} ${args.join(' ')} (cwd ${cwd})`);
    let started;
    try {
      started = await startOnce({ command, args, cwd, log });
    } catch (error) {
      await note(log, `attempt ${attempt} could not spawn: ${error?.message ?? error}`);
      await sleep(BACKOFF_MS);
      continue;
    }
    const { child, outcome } = started;
    if (outcome.state === 'alive') {
      await note(log, `attempt ${attempt} is alive (pid ${child.pid ?? 'unknown'}); helper exiting`);
      return 0;
    }
    const detail = outcome.error?.message ?? `code ${outcome.code ?? 'null'} signal ${outcome.signal ?? 'null'}`;
    await note(log, `attempt ${attempt} exited immediately (${detail})`);
    if (outcome.code === 0 && outcome.error === undefined) {
      await note(log, 'attempt exited cleanly; treating the restart as done');
      return 0;
    }
    await sleep(BACKOFF_MS);
  }

  await note(log, `relaunch helper gave up after ${ATTEMPTS} attempts; DSH is not running`);
  return 1;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    process.stderr.write(`relaunch: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
