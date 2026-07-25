import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_ITEMS = 1_000;
const DEFAULT_MAX_ITEM_BYTES = 1_048_576;
const CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})?$/i;
const FRONTMATTER_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type OkfValue = string | number | boolean | string[];
export type OkfFrontmatter = {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  [key: string]: OkfValue | undefined;
};

export type RawItem = {
  /** Stable provider identity retained in the rendered source metadata. */
  logicalName: string;
  /** Optional human-readable filename base, such as an email subject. */
  fileNameHint?: string;
  okf: OkfFrontmatter;
  body: string;
};

export type WriteRawMarkdownInput = {
  workspacePath: string;
  connectorId: string;
  instanceId: string;
  items: RawItem[];
  maxItems?: number;
  maxItemBytes?: number;
};

export type WriteRawMarkdownResult = {
  written: string[];
  skipped: string[];
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Human-readable base slug for the source file, derived from the item's name
 * (the mail subject via `fileNameHint`, falling back to `logicalName`). No
 * identity hash is appended: the file is named after the mail. The subject is
 * the canonical destination: a later item with the same subject replaces it
 * atomically, while byte-identical content is skipped.
 * `logicalName` is still validated for path/control safety even when unused in
 * the name, as defence in depth.
 */
function sourceBaseSlug(logicalName: string, fileNameHint?: string): string {
  const normalizedName = logicalName.trim().replace(/\.md$/i, '');
  if (
    !normalizedName ||
    /[\\/]/.test(normalizedName) ||
    CONTROL_CHAR_PATTERN.test(normalizedName)
  ) {
    throw new Error(
      'logicalName must be non-empty and contain no path separator or control character.',
    );
  }
  const normalizedHint = fileNameHint?.trim().replace(/\.md$/i, '') ?? '';
  if (normalizedHint && (/[\\/]/.test(normalizedHint) || CONTROL_CHAR_PATTERN.test(normalizedHint))) {
    throw new Error('fileNameHint must contain no path separator or control character.');
  }
  const slug = slugify(normalizedHint) || slugify(normalizedName);
  if (!slug) {
    throw new Error('logicalName must contain at least one letter or number.');
  }
  return slug.slice(0, 80);
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONNECTOR_ID_PATTERN.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`${label} must be a safe connector identifier.`);
  }
  return normalized;
}

function validateText(value: string, label: string): void {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`${label} contains forbidden control characters.`);
  }
}

function serializeValue(value: OkfValue, key: string): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Front matter "${key}" must contain a finite number.`);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new Error(`Front matter "${key}" arrays may contain only strings.`);
      }
      validateText(entry, `Front matter "${key}"`);
    }
  } else if (typeof value === 'string') {
    validateText(value, `Front matter "${key}"`);
  }
  return JSON.stringify(value);
}

export function serializeRawItem(item: RawItem): string {
  if (!item.okf || typeof item.okf !== 'object' || Array.isArray(item.okf)) {
    throw new Error('okf front matter must be an object.');
  }
  if (typeof item.okf.type !== 'string' || !item.okf.type.trim()) {
    throw new Error('OKF front matter "type" is required and must be non-empty.');
  }
  validateText(item.body, 'Markdown body');

  const entries = Object.entries(item.okf).filter(
    (entry): entry is [string, OkfValue] => entry[1] !== undefined,
  );
  const orderedEntries = [
    entries.find(([key]) => key === 'type')!,
    ...entries.filter(([key]) => key !== 'type').sort(([a], [b]) => a.localeCompare(b)),
  ];
  const frontmatter = orderedEntries.map(([key, value]) => {
    if (!FRONTMATTER_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid front matter key: ${key}`);
    }
    return `${key}: ${serializeValue(value, key)}`;
  });
  const body = item.body.trim();
  return `---\n${frontmatter.join('\n')}\n---\n\n${body}${body ? '\n' : ''}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readExisting(filePath: string): Promise<string | undefined> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a non-regular source: ${filePath}`);
    }
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.tmp-${path.basename(filePath, '.md')}-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(tempPath, 'wx', 0o644);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeRawMarkdown(
  input: WriteRawMarkdownInput,
): Promise<WriteRawMarkdownResult> {
  const connectorId = validateIdentifier(input.connectorId, 'connectorId');
  const instanceId = validateIdentifier(input.instanceId, 'instanceId');
  if (!instanceId.startsWith(`${connectorId}-`) && instanceId !== connectorId) {
    throw new Error('instanceId must equal connectorId or start with "<connectorId>-".');
  }
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxItemBytes = input.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || input.items.length > maxItems) {
    throw new Error(`Collection exceeds the maximum of ${maxItems} items.`);
  }
  if (!Number.isSafeInteger(maxItemBytes) || maxItemBytes < 1) {
    throw new Error('maxItemBytes must be a positive safe integer.');
  }

  const workspaceRoot = await realpath(path.resolve(input.workspacePath));
  const workspaceStats = await lstat(workspaceRoot);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error('workspacePath must resolve to a real directory.');
  }
  const untrackedRoot = path.join(workspaceRoot, 'raw', 'untracked');
  const targetDir = path.join(untrackedRoot, 'connectors', instanceId);
  await mkdir(targetDir, { recursive: true });
  const canonicalUntrackedRoot = await realpath(untrackedRoot);
  const canonicalTargetDir = await realpath(targetDir);
  if (!isInside(canonicalUntrackedRoot, canonicalTargetDir)) {
    throw new Error('Connector output directory escapes raw/untracked.');
  }

  const result: WriteRawMarkdownResult = { written: [], skipped: [] };

  for (const item of input.items) {
    const base = sourceBaseSlug(item.logicalName, item.fileNameHint);
    const content = serializeRawItem(item);
    if (Buffer.byteLength(content, 'utf8') > maxItemBytes) {
      throw new Error(`Rendered item "${item.logicalName}" exceeds ${maxItemBytes} bytes.`);
    }

    const fileName = `${base}.md`;
    const target = path.join(canonicalTargetDir, fileName);
    if (!isInside(canonicalTargetDir, target) || path.extname(target) !== '.md') {
      throw new Error('Rendered source target is outside the connector output directory.');
    }
    const relativePath = path.relative(workspaceRoot, target).split(path.sep).join('/');
    const existing = await readExisting(target);
    if (existing === content) {
      result.skipped.push(relativePath);
      continue;
    }
    await atomicWrite(target, content);
    result.written.push(relativePath);
  }
  return result;
}
