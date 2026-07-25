# agent-connectors

Multi-workspace connector agent for wikiLLM's SaaS sources.

## Status (batch 4 — Gmail read-only + durable Google OAuth)

The agent now exposes the generic five-tool orchestration contract through a
**Streamable HTTP** MCP server (official `@modelcontextprotocol/sdk`):

| Tool             | Role |
| ---------------- | ---- |
| `agent_describe` | Publishes the contract: capability `external-source.collect`, executor-only (`canPlan:false`, `singleTaskOnly:true`), `mutationClass:external-source`, `defaultRequiresApproval:true`, idempotency supported. |
| `agent_plan`     | Refuses — planning is delegated to Donna. |
| `agent_execute`  | Runs an `external-source.collect` task → collects via a *collector*, then writes OKF Markdown through the sink. Idempotent per `idempotencyKey`. |
| `agent_status`   | Task status by `jobId`, or capability status (input discovery) when no `jobId` is given. |
| `agent_cancel`   | Cooperative cancellation of a non-terminal job. |

Two direct, non-orchestrated tools support interactive clients:

| Tool | Role |
| --- | --- |
| `connectors_google_status` | Reports Gmail authorization status for the active workspace. |
| `connectors_google_oauth_start` | Returns the Google authorization URL without starting a collection. |

The manager injects the active workspace into these direct tools. Served chat
allow-lists only these two connector tools; the five orchestration tools remain
runtime-only.

The core (`src/agent.ts`) is **transport-agnostic**: it owns the idempotent job
store, resolves the workspace (anti-traversal, modelled on `agent-cme`), runs
the collector, and drives the sink. `src/server.ts` only binds those methods to
the five MCP tools.

The production server registers a read-only Gmail collector
(`src/gmail.ts`). It uses Gmail's `gmail.readonly` scope, bounded pagination,
one refresh-and-retry after HTTP 401, MIME text extraction, HTML-to-text
fallback and an OKF `Email` renderer. It writes through the same
`writeRawMarkdown` sink as the fixture used by contract tests.

Google tokens are isolated under
`$AGENT_DATA_DIR/<workspace>/<instanceId>/tokens.json`, written atomically with
mode `0600`. `GoogleTokenProvider` refreshes expiring tokens and persists the
replacement access token without exposing it through job results. Token files
must explicitly contain the `gmail.readonly` scope; missing scope metadata is
rejected fail-closed.

The durable Google OAuth flow uses PKCE S256 and an HMAC-signed, expiring,
single-use state correlated to workspace and instance. Pending authorization
state is persisted with mode `0600`, so the callback survives an agent restart.
Concurrent callbacks claim the pending file with an atomic rename, ensuring
that only one callback can exchange the authorization code.
There is no implicit loopback mode: HTTPS is required except when the configured
callback explicitly targets `localhost` or `127.0.0.1`.

- `POST /oauth/google/start` starts authorization and requires
  `Authorization: Bearer $OAUTH_START_TOKEN`.
- `GET /oauth/google/callback` is public, validates and consumes `state`, then
  stores the exchanged tokens.

The start token and state-signing secret are deliberately separate. OAuth start
is disabled unless all required OAuth variables are configured.

OAuth token responses may omit `scope` when it is unchanged from the
authorization request. Token state records this distinction as `scopeSource`:
`token-response` when Google returned it, or
`authorization-request-default` when the requested `gmail.readonly` scope was
used as the protocol fallback.

Provider failures are reduced to non-secret operational reasons in job status:
`authentication_required`, `authentication_failed`, `provider_rate_limited`,
`provider_unavailable`, or the fallback `collection_failed`.

The `writeRawMarkdown` sink turns OKF items into atomic Markdown files under:

```text
<workspace>/raw/untracked/connectors/<instanceId>/
```

Jobs are persisted atomically under
`$AGENT_DATA_DIR/<workspace>/jobs/jobs.json`. Idempotency keys are scoped by
workspace and bound to a stable request fingerprint: a replay returns the same
job, while reusing a key with a different payload is rejected. A queued or
running job recovered after restart becomes `failed/interrupted_by_restart`;
the agent never silently repeats an ambiguous collection. The agent never runs
`ingest`.

### Retry after an interrupted restart

An idempotency key belongs to one execution attempt. When restart recovery marks
a job `failed/interrupted_by_restart`, that key remains terminal: submitting it
again returns the same failed job and never starts another collection.

The orchestrator must make an explicit retry decision and generate a **new
`idempotencyKey`** for the new attempt. Reusing the old key is only appropriate
for polling or replaying the outcome of the interrupted attempt.

## Running the server

```bash
npm start   # listens on http://0.0.0.0:$CONNECTORS_PORT/mcp (default 3338)
```

Environment: `WORKSPACES_ROOT` (default `/workspaces`, mounted by the manager),
`AGENT_DATA_DIR` (default `/data`, persisted by the manager),
`AGENT_INSTANCE_ID`, `CONNECTORS_DISPLAY_NAME`, `CONNECTORS_PORT`,
`CONNECTORS_RECOMMENDED_CONCURRENCY` (default 2), `CONNECTORS_MAX_CONCURRENCY`
(default 4), the optional advanced override `GOOGLE_OAUTH_CLIENT_ID` (alias
`GOOGLE_CLIENT_ID`), the optional compatibility override
`GOOGLE_OAUTH_CLIENT_SECRET` (alias
`GOOGLE_CLIENT_SECRET`), `GOOGLE_OAUTH_CALLBACK_URL`,
`OAUTH_STATE_SECRET` (minimum 32 bytes), `OAUTH_START_TOKEN` (minimum 32 bytes),
and `OAUTH_STATE_TTL_SECONDS` (default 600). The manager injects the active
workspace on every `agent_execute`.

`GOOGLE_OAUTH_CALLBACK_URL` must exactly match an authorized redirect URI in
Google Cloud Console. For a local Docker installation, the manager generates
`http://127.0.0.1:<published-port>/oauth/google/callback`; the browser reaches
the agent through Docker's published host port. A remote deployment instead
uses its explicit public HTTPS URL. Never use the container hostname as a
redirect URI.

The local Desktop flow uses PKCE and does not require a Client Secret. When no
secret is configured, code exchange and refresh requests omit
`client_secret`. Official images receive the public wikiLLM Desktop Client ID
through the `WIKILLM_GOOGLE_OAUTH_CLIENT_ID` build argument; it is deliberately
absent from the source repository. `GOOGLE_OAUTH_CLIENT_ID` is only an
administrator override. A secret is
accepted only for compatibility with a confidential web-client registration.

Start authorization:

```bash
curl -X POST http://agent-connectors:3337/oauth/google/start \
  -H "Authorization: Bearer $OAUTH_START_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"demo","instanceId":"google-1"}'
```

A Gmail execution uses:

```json
{
  "operation": "collect",
  "workspace": { "name": "demo" },
  "idempotencyKey": "attempt-specific-key",
  "arguments": {
    "connectorId": "google",
    "instanceId": "google-1",
    "query": "newer_than:1d",
    "maxMessages": 50
  }
}
```

## Validation

```bash
npm test        # native node --test suite
npm run typecheck   # tsc --strict --noEmit
```

The tests cover the sink (deterministic names, content idempotency, atomic
writes, size limits and path guards, and the real `llm-wiki` lifecycle after
archiving — the integration test imports the engine from the sibling repo
`../../llm-wiki`) **and** the agent contract: executor-only `describe`,
`execute` producing a real raw markdown file via the sink, persistent
workspace-scoped `idempotencyKey` deduplication, changed-payload rejection,
ambiguous restart recovery, workspace escape rejection, capability status,
unsupported-operation rejection, and cancel. Gmail tests cover token isolation
and permissions, proactive refresh and 401 refresh, bounded pagination, MIME
decoding, HTML cleanup (including encoded-tag injection), fail-closed scope
validation, non-secret failure reasons, OKF rendering, and the full
`agent_execute → GmailCollector → writeRawMarkdown` path. OAuth tests cover
PKCE, signed/expired/tampered state, persistence across restart, one-time
consumption, token exchange, scope rejection and callback URL policy.
