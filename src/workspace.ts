import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * A workspace reference as sent by the orchestrator on agent_execute. The
 * manager injects the active workspace name; an explicit path is accepted too
 * (used by tests and by hosts that mount a single workspace directly).
 */
export type WorkspaceRef = { name?: string; path?: string } | string | undefined;

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})?$/i;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a workspace reference to a real, existing directory under the
 * configured workspaces root. Rejects traversal, symlinks escaping the root,
 * and unsafe names — mirroring agent-cme's `_validate_workspace`.
 */
export async function resolveWorkspacePath(
  ref: WorkspaceRef,
  workspacesRoot: string,
): Promise<{ name: string; path: string }> {
  const name = typeof ref === 'string' ? ref : ref?.name;
  const explicitPath = typeof ref === 'string' ? undefined : ref?.path;

  const root = await realpath(path.resolve(workspacesRoot)).catch(() => {
    throw new Error(`workspaces root does not exist: ${path.resolve(workspacesRoot)}`);
  });
  let target: string;
  let resolvedName: string;
  if (explicitPath) {
    target = path.resolve(explicitPath);
    resolvedName = name?.trim() || path.basename(target);
    if (
      !NAME_PATTERN.test(resolvedName) ||
      resolvedName === '.' ||
      resolvedName === '..'
    ) {
      throw new Error('workspace.name must be a safe workspace identifier.');
    }
  } else {
    if (!name || !NAME_PATTERN.test(name) || name === '.' || name === '..') {
      throw new Error('workspace.name must be a safe workspace identifier.');
    }
    resolvedName = name;
    target = path.join(root, name);
    if (!isInside(root, target)) {
      throw new Error('workspace escapes the workspaces root.');
    }
  }

  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    throw new Error(`workspace "${resolvedName}" does not exist.`);
  }
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) {
    throw new Error(`workspace "${resolvedName}" is not a directory.`);
  }
  if (!isInside(root, canonical)) {
    throw new Error('workspace escapes the workspaces root.');
  }
  return { name: resolvedName, path: canonical };
}
