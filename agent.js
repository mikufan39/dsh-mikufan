/**
 * dsh-mikufan — Agent instructions engine.
 *
 * The Harness loads `<DSH home>/AGENTS.md` as its user-global instruction file
 * (`@deepseek-ai/dsh-agent-instructions` resolves `$DSH_HOME` or `~/.dsh` and
 * reads `AGENTS.md` from it), so the Control panel's Agent page edits exactly
 * that file: one text box, one save, and the next session carries the text.
 * Project-level `AGENTS.md` files still apply on top of it.
 *
 * A missing file is the normal blank state, not an error: the page starts with
 * an empty box and the placeholder. Blank text removes the file again, so
 * clearing the box is how the user drops the user-global instructions.
 *
 * The write is done in place instead of through a temporary file + rename: a
 * user-managed `AGENTS.md` is often a symlink into a dotfiles repository, and a
 * rename would replace the link with a regular file.
 *
 * @module dsh-mikufan/agent
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File name of the user-global instruction file under the Harness home. */
export const AGENT_INSTRUCTIONS_FILE = 'AGENTS.md';
/** Largest accepted instruction text, in characters (64 KiB of Markdown). */
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 64 * 1024;

/** Absolute path of the file the Agent page edits. */
export function agentInstructionsPath(dshHome) {
  return join(dshHome, AGENT_INSTRUCTIONS_FILE);
}

/** Build one engine error carrying the route-facing code. */
function agentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read the user-global instruction file.
 *
 * A missing file is the blank state; a leading BOM is dropped so the textarea
 * does not show an invisible character before the first heading.
 *
 * @param dshHome - the Harness home (`~/.dsh`).
 * @returns `{ path, exists, content, updatedAt }` — `updatedAt` is the file's
 *   modification time as an ISO string (empty when the file does not exist).
 */
export async function readAgentInstructions(dshHome) {
  const path = agentInstructionsPath(dshHome);
  try {
    const info = await stat(path);
    const raw = await readFile(path, 'utf8');
    const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return { path, exists: true, content, updatedAt: new Date(info.mtimeMs).toISOString() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, exists: false, content: '', updatedAt: '' };
    throw agentError('unavailable', `cannot read ${path}: ${error?.message ?? error}`);
  }
}

/**
 * Save the instruction text, or remove the file for blank text.
 *
 * @param dshHome - the Harness home (`~/.dsh`).
 * @param content - the whole AGENTS.md text.
 * @returns `{ path, exists, content, bytes, updatedAt }` (`{ removed: true }`
 *   when cleared; `updatedAt` is empty for a removal).
 */
export async function saveAgentInstructions(dshHome, content) {
  if (typeof content !== 'string') {
    throw agentError('bad-content', 'content must be a string');
  }
  if (content.length > MAX_AGENT_INSTRUCTIONS_LENGTH) {
    throw agentError('too-large', `content must be at most ${MAX_AGENT_INSTRUCTIONS_LENGTH} characters`);
  }
  const path = agentInstructionsPath(dshHome);
  if (content.trim() === '') {
    try {
      await rm(path, { force: true });
    } catch (error) {
      throw agentError('unavailable', `cannot remove ${path}: ${error?.message ?? error}`);
    }
    return { path, exists: false, content: '', bytes: 0, updatedAt: '', removed: true };
  }
  try {
    await mkdir(dshHome, { recursive: true });
    await writeFile(path, content, 'utf8');
    const info = await stat(path);
    return {
      path,
      exists: true,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      updatedAt: new Date(info.mtimeMs).toISOString(),
    };
  } catch (error) {
    throw agentError('unavailable', `cannot write ${path}: ${error?.message ?? error}`);
  }
}
