import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorMessage } from '../bridge/util.ts';
import { jsonResult } from '../mcpResult.ts';
import { resolveWorkspacePath } from '../workspace.ts';
import type { BridgeManager } from './bridgeManager.ts';

/**
 * Tchap bridge set-up, reached through Donna like the Gmail and CME set-up
 * tools — the user never runs a script. The Tchap sign-in is shared by every
 * workspace (like CME's credentials); each workspace has its own forum.
 * Read-only: status, forums (offered in chat mode). Changes: connect (attach
 * a forum), disconnect (detach this workspace's forum), signout (end the
 * shared sign-in for all workspaces). Who may speak to
 * Donna is deliberately NOT a tool: the owner changes it from the Tchap
 * conversation itself (/allow, /deny), so no prompt injection can add a
 * listener.
 */

/** Every handler answers with JSON; an exception becomes `{ ok: false, error }`, never an MCP error. */
function handler<T>(run: (args: T) => Promise<unknown> | unknown) {
  return async (args: T) => {
    try {
      return jsonResult(await run(args));
    } catch (error) {
      return jsonResult({ ok: false, error: errorMessage(error) });
    }
  };
}

export function registerTchapTools(
  server: McpServer,
  options: { bridges: BridgeManager; workspacesRoot: string },
): void {
  const { bridges } = options;
  const resolve = async (workspace: string) =>
    (await resolveWorkspacePath({ name: workspace }, options.workspacesRoot)).name;

  server.registerTool(
    'connectors_tchap_status',
    {
      description:
        'State of the Tchap bridge of the active workspace — the bridge lets the user talk to Donna ' +
        'from a Tchap forum on their phone. `phase` sums it up (not_set_up, signin_pending, signin_failed, ' +
        'signed_out, no_forum, awaiting_activation, active, paused, stopped); the other fields give the ' +
        'account, this workspace\'s forum, who may speak, a pending sign-in code and the last error. The Tchap ' +
        'account is shared by every workspace; the forum is per workspace. Call it first for any question about Tchap.',
      inputSchema: { workspace: z.string() },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { workspace: string }) => ({ ok: true, ...bridges.status(await resolve(args.workspace)) })),
  );

  server.registerTool(
    'connectors_tchap_forums',
    {
      description:
        'List the Tchap forums of the signed-in account that a workspace can use (unencrypted, administered ' +
        'by the user), with the workspace already using each one (`usedBy`). Use it to offer the user a forum ' +
        'by name instead of asking for its address. Requires Tchap to be connected.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(() => bridges.forums()),
  );

  server.registerTool(
    'connectors_tchap_connect',
    {
      description:
        'Attach a Tchap forum to the active workspace so the user can talk to Donna from their phone ' +
        '("connect Tchap", "use the forum #…"). `room` is the forum address (#name:agent.<ministry>.tchap.gouv.fr) ' +
        'or its internal id (!…:server) — connectors_tchap_forums lists the usable ones. When Tchap is not signed ' +
        'in yet it returns a verificationUri and a userCode: show BOTH to the user, who opens the URL on their ' +
        'phone, signs in to Tchap and confirms the code; the bridge finishes on its own. Signed in already: no ' +
        'code. The forum must be unencrypted, administered by the user, have no other member and not be used by ' +
        'another workspace. Once set up, tell the user to type /activate in the forum — nothing is relayed before.',
      inputSchema: { workspace: z.string(), room: z.string() },
      annotations: { readOnlyHint: false },
    },
    handler(async (args: { workspace: string; room: string }) => {
      const result = await bridges.connect(await resolve(args.workspace), args.room);
      if (!result.ok) return result;
      return {
        ...result,
        next: result.pending
          ? 'Show the user the verification URL and code; once confirmed, the forum is checked and the bridge waits for /activate typed in the forum.'
          : 'Tell the user to type /activate in the forum to switch the bridge on.',
      };
    }),
  );

  server.registerTool(
    'connectors_tchap_disconnect',
    {
      description:
        'Detach the active workspace from its Tchap forum: its bridge stops and the forum is forgotten. The ' +
        'Tchap sign-in and the other workspaces\' forums are untouched. To end the sign-in for every ' +
        'workspace, use connectors_tchap_signout.',
      inputSchema: { workspace: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler(async (args: { workspace: string }) => bridges.disconnect(await resolve(args.workspace))),
  );

  server.registerTool(
    'connectors_tchap_signout',
    {
      description:
        'Sign out of Tchap for EVERY workspace: all bridges stop and the shared Tchap session is revoked. ' +
        'Each workspace keeps its forum; the next "connect Tchap" (one new code) restarts them all. Use it ' +
        'only when the user asks to disconnect the Tchap account itself.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler(() => bridges.signOut()),
  );
}
