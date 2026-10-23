/**
 * dsh-mikufan — Skills engine (Host half).
 *
 * The skills page manages the user skill root the Harness already scans
 * (`<dshHome>/skills`, the `user-dsh` provider row): one directory bundle
 * `<name>/SKILL.md` or one flat `<name>.md` per skill, YAML frontmatter with a
 * required `name` and `description`.
 *
 * - The root is created on first run; DSH ships no skills folder.
 * - The plugin bundles one skill (`skill-creator`) and installs it into the
 *   root only when that directory is absent, so a user edit is never lost.
 * - A skill's `disable-model-invocation: true` flag is the card switch: on
 *   means the model sees the skill, off keeps it on disk but out of the
 *   model-facing catalog.
 * - Writes are atomic (temp file + rename); a created skill is discovered by
 *   the Harness provider through its existing watcher.
 *
 * @module dsh-mikufan/skills
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Directory name of the user skill root, under `<DSH home>`. */
export const SKILLS_DIR_NAME = 'skills';
/** Instruction file of a directory-bundle skill. */
export const SKILL_FILE_NAME = 'SKILL.md';
/** Kebab-case skill name: the Harness provider's grammar (no leading/trailing/double dashes). */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Cap for one skill name, matching the provider. */
export const MAX_SKILL_NAME = 64;
/** Cap for one skill description, guarded here so a card stays readable. */
export const MAX_SKILL_DESCRIPTION = 500;
/** Cap for the SKILL.md bytes this panel will read or write. */
export const MAX_SKILL_BYTES = 512 * 1024;
/** Frontmatter key that keeps a skill out of model-facing catalogs. */
const DISABLE_MODEL_KEY = 'disable-model-invocation';
/** Frontmatter keys the provider rejects (it wants kebab-case invocation keys). */
const REJECTED_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];

/** One bad-input error carrying a stable code for the route layer. */
function skillError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Parse one YAML boolean in the grammar the provider accepts.
 * @param value - raw frontmatter value.
 * @returns true / false, or null when the value is not a boolean.
 */
function parseYamlBoolean(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return null;
}

/**
 * Whether a value is one of the YAML spellings of true the provider accepts.
 * @param value - raw frontmatter value.
 * @returns true for true/yes/on/1 in any case.
 */
function isYamlTrue(value) {
  return parseYamlBoolean(value) === true;
}

/**
 * Unwrap one scalar value: quoted strings lose their quotes, everything else
 * is returned trimmed.
 * @param raw - text after the colon.
 * @returns the scalar.
 */
function yamlScalar(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * Split one SKILL.md into its raw frontmatter lines and the markdown body.
 * Only a frontmatter block that opens on the very first line counts, with no
 * BOM tolerance: the provider parses the raw file, so the panel does too.
 * @param text - file content.
 * @returns the parts, with `hasFrontmatter` false when none was found.
 */
export function splitSkillDocument(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { hasFrontmatter: false, frontmatterLines: [], body: source };
  }
  const close = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (close === -1) {
    return { hasFrontmatter: false, frontmatterLines: [], body: source };
  }
  const end = close + 1;
  return {
    hasFrontmatter: true,
    frontmatterLines: lines.slice(1, end),
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * Read the top-level frontmatter scalars of one skill document.
 * Nested mappings (`metadata:`) are skipped and YAML block scalars (`>` / `|`)
 * are folded, so a multi-line description reaches a card as one string.
 * @param text - file content.
 * @returns the parsed scalars.
 */
export function readSkillFrontmatter(text) {
  const { frontmatterLines } = splitSkillDocument(text);
  const data = {};
  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(frontmatterLines[index]);
    if (match === null) continue;
    const key = match[1];
    let raw = match[2];
    const block = /^([>|])[+-]?$/.exec(raw.trim());
    if (block !== null) {
      const parts = [];
      let cursor = index + 1;
      while (cursor < frontmatterLines.length) {
        const line = frontmatterLines[cursor];
        if (line.trim() !== '' && !/^\s+/.test(line)) break;
        parts.push(line.trim());
        cursor += 1;
      }
      index = cursor - 1;
      raw = block[1] === '>' ? parts.join(' ').trim() : parts.join('\n').trim();
    }
    data[key] = yamlScalar(raw);
  }
  return data;
}

/**
 * Summarize one skill document for a card. The provider's own strictness is
 * mirrored: an invalid name, a missing description, a legacy camelCase
 * invocation key or a non-boolean flag makes it drop the skill, so the panel
 * does not list it either.
 * @param options - id, absolute path, kind ('bundle' | 'file'), raw text, mtime, bytes.
 * @returns the card entry, or null when the document is not a valid skill.
 */
export function summarizeSkill({ id, path, kind, text, mtimeMs, bytes }) {
  const data = readSkillFrontmatter(text);
  const name = typeof data.name === 'string' && data.name !== '' ? data.name : '';
  const description = typeof data.description === 'string' ? data.description : '';
  if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME) return null;
  if (description.trim() === '') return null;
  for (const key of REJECTED_INVOCATION_KEYS) {
    if (data[key] !== undefined) return null;
  }
  if (data[DISABLE_MODEL_KEY] !== undefined && parseYamlBoolean(data[DISABLE_MODEL_KEY]) === null) return null;
  return {
    id,
    name,
    description,
    enabled: !isYamlTrue(data[DISABLE_MODEL_KEY]),
    kind,
    path,
    bytes: Number.isInteger(bytes) ? bytes : Buffer.byteLength(text, 'utf8'),
    updatedAt: new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now()).toISOString(),
  };
}

/**
 * Rewrite one skill document's model-invocation flag, preserving every other
 * frontmatter line and the whole body. Enabling drops the key entirely.
 * @param text - current file content.
 * @param enabled - true keeps the skill model-invocable.
 * @returns the next document.
 */
export function setSkillEnabledInDocument(text, enabled) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  const hasFrontmatter = lines.length > 0 && lines[0].trim() === '---';
  if (!hasFrontmatter) throw skillError('the skill file has no frontmatter', 'bad-document');
  const close = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (close === -1) throw skillError('the skill frontmatter is not closed', 'bad-document');
  const end = close + 1;
  const kept = lines.slice(1, end).filter((line) => !new RegExp(`^${DISABLE_MODEL_KEY}\\s*:`, 'i').test(line));
  if (!enabled) kept.push(`${DISABLE_MODEL_KEY}: true`);
  // Keep the file's own line-ending style: Windows-authored skills stay CRLF.
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const next = ['---', ...kept, '---', ...lines.slice(end + 1)].join(eol);
  return next.endsWith(eol) ? next : `${next}${eol}`;
}

/** @returns whether the path exists (any type). */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write one text file atomically (temp file + rename) inside its directory. */
async function writeTextAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, file);
}

/**
 * Resolve the managed skill root and create it when missing.
 * @param dshHome - harness home (`$DSH_HOME` or `~/.dsh`).
 * @returns the absolute root path.
 */
export async function ensureSkillsRoot(dshHome) {
  const root = join(dshHome, SKILLS_DIR_NAME);
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Install one bundled skill directory into the managed root when absent.
 * Never overwrites, and never reinstalls a skill the user removed: the marker
 * file records that the bundled copy was installed once.
 * @param sourceDir - absolute path of the bundled skill inside this package.
 * @param root - managed skill root.
 * @param name - the skill's directory name.
 * @param log - reporter.
 * @param markerFile - optional absolute path of the install-marker JSON.
 * @returns whether a copy was made.
 */
export async function installBundledSkill(sourceDir, root, name, log, markerFile) {
  const target = join(root, name);
  if (await pathExists(target)) {
    await writeInstallMarker(markerFile, name).catch(() => {});
    return false;
  }
  if (typeof markerFile === 'string' && markerFile !== '') {
    const marker = await readInstallMarker(markerFile);
    if (marker[name] !== undefined) {
      log(`bundled skill ${name} was installed before and is gone; leaving it removed`);
      return false;
    }
  }
  await cp(sourceDir, target, { recursive: true, force: false, errorOnExist: false });
  await writeInstallMarker(markerFile, name).catch(() => {});
  log(`installed bundled skill ${name} → ${target}`);
  return true;
}

/** Read the install marker (`{ <skill>: iso }`); any failure is an empty marker. */
async function readInstallMarker(file) {
  if (typeof file !== 'string' || file === '') return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && typeof parsed.installed === 'object' && parsed.installed !== null
      ? parsed.installed
      : {};
  } catch {
    return {};
  }
}

/** Record one bundled skill's install time in the marker file. */
async function writeInstallMarker(file, name) {
  if (typeof file !== 'string' || file === '') return;
  await mkdir(dirname(file), { recursive: true });
  const installed = await readInstallMarker(file);
  installed[name] = new Date().toISOString();
  await writeTextAtomic(file, `${JSON.stringify({ version: 1, installed }, null, 2)}\n`);
}

/**
 * List every valid skill directly under the managed root.
 * @param root - managed skill root.
 * @returns the card entries sorted by name.
 */
export async function listSkills(root) {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  const seen = new Set();
  // Bundles first: when `foo/SKILL.md` and `foo.md` both exist, the directory
  // bundle wins (the same precedence a skill directory has over a flat file).
  const ordered = [...dirents].sort((left, right) => {
    const leftDirectory = left.isDirectory() || left.isSymbolicLink() ? 0 : 1;
    const rightDirectory = right.isDirectory() || right.isSymbolicLink() ? 0 : 1;
    return leftDirectory - rightDirectory;
  });
  for (const dirent of ordered) {
    if (dirent.name.startsWith('.')) continue;
    const target = join(root, dirent.name);
    // A symlinked bundle resolves to its target: stat follows the link.
    const targetInfo = await stat(target).catch(() => undefined);
    if (targetInfo === undefined) continue;
    if (targetInfo.isDirectory()) {
      // The directory name is the entry id; an id the resolver would reject
      // must not become a dead card.
      if (!SKILL_NAME_PATTERN.test(dirent.name) || dirent.name.length > MAX_SKILL_NAME) continue;
      const file = join(target, SKILL_FILE_NAME);
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const summary = summarizeSkill({
        id: dirent.name,
        path: file,
        kind: 'bundle',
        text,
        mtimeMs: info.mtimeMs,
        bytes: info.size,
      });
      if (summary !== null && !seen.has(summary.id)) {
        seen.add(summary.id);
        entries.push(summary);
      }
      continue;
    }
    if (!dirent.name.endsWith('.md')) continue;
    const flatId = dirent.name.slice(0, -3);
    if (!SKILL_NAME_PATTERN.test(flatId) || flatId.length > MAX_SKILL_NAME) continue;
    const info = await stat(target).catch(() => undefined);
    if (info === undefined) continue;
    const text = await readFile(target, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const summary = summarizeSkill({
      id: flatId,
      path: target,
      kind: 'file',
      text,
      mtimeMs: info.mtimeMs,
      bytes: info.size,
    });
    if (summary !== null && !seen.has(summary.id)) {
      seen.add(summary.id);
      entries.push(summary);
    }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return entries;
}

/**
 * Resolve one skill's instruction file by id, refusing anything outside the root.
 * @param root - managed skill root.
 * @param id - entry id (bundle directory name or flat file basename).
 * @returns the file path, or null when the skill does not exist.
 */
export async function resolveSkillFile(root, id) {
  if (!SKILL_NAME_PATTERN.test(String(id ?? ''))) return null;
  const bundleFile = join(root, id, SKILL_FILE_NAME);
  if (await pathExists(bundleFile)) return bundleFile;
  const flatFile = join(root, `${id}.md`);
  if (await pathExists(flatFile)) return flatFile;
  return null;
}

/** Read one skill document (raw text + its summary + body). */
export async function readSkill(root, id) {
  const file = await resolveSkillFile(root, id);
  if (file === null) return null;
  const info = await stat(file);
  const text = await readFile(file, 'utf8');
  const kind = file.endsWith(SKILL_FILE_NAME) ? 'bundle' : 'file';
  const entry = summarizeSkill({ id, path: file, kind, text, mtimeMs: info.mtimeMs, bytes: info.size });
  if (entry === null) return null;
  const { body } = splitSkillDocument(text);
  return { ...entry, markdown: body.replace(/^\s*\n/, '') };
}

/**
 * Create one skill as a directory bundle under the managed root.
 * @param root - managed skill root.
 * @param input - `{ name, description, body? }`.
 * @param log - reporter.
 * @returns the created entry.
 */
export async function createSkill(root, input, log) {
  const name = String(input?.name ?? '').trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME) {
    throw skillError('skill name must be kebab-case: lowercase letters, digits and single dashes', 'bad-name');
  }
  const description = String(input?.description ?? '').trim();
  if (description === '') throw skillError('a skill description is required', 'bad-description');
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw skillError(`the description exceeds ${MAX_SKILL_DESCRIPTION} characters`, 'bad-description');
  }
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (body.length > MAX_SKILL_BYTES) throw skillError('the body is too large', 'bad-body');
  const directory = join(root, name);
  if (await pathExists(directory) || await pathExists(join(root, `${name}.md`))) {
    throw skillError(`a skill named ${name} already exists`, 'exists');
  }
  await mkdir(directory, { recursive: false });
  const text = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    body === '' ? `# ${name}\n\n${description}` : body,
    '',
  ].join('\n');
  await writeTextAtomic(join(directory, SKILL_FILE_NAME), text);
  log(`skill created via panel: ${name}`);
  return readSkill(root, name);
}

/**
 * Flip one skill's model-invocation flag.
 * @param root - managed skill root.
 * @param id - entry id.
 * @param enabled - desired state.
 * @param log - reporter.
 * @returns the updated entry, or null when the skill does not exist.
 */
export async function setSkillEnabled(root, id, enabled, log) {
  const file = await resolveSkillFile(root, id);
  if (file === null) return null;
  const text = await readFile(file, 'utf8');
  const next = setSkillEnabledInDocument(text, enabled === true);
  await writeTextAtomic(file, next);
  log(`skill ${id} ${enabled === true ? 'enabled' : 'disabled'} via panel`);
  return readSkill(root, id);
}

/**
 * Remove one skill (its bundle directory, or its flat file).
 * @param root - managed skill root.
 * @param id - entry id.
 * @param log - reporter.
 * @returns whether something was removed.
 */
export async function removeSkill(root, id, log) {
  const file = await resolveSkillFile(root, id);
  if (file === null) return false;
  const bundleDir = join(root, id);
  const isBundle = file === join(bundleDir, SKILL_FILE_NAME);
  await rm(isBundle ? bundleDir : file, { recursive: isBundle, force: true });
  log(`skill removed via panel: ${id}`);
  return true;
}
