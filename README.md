# agent-connectors

Multi-workspace connector agent for wikiLLM's SaaS sources.

## Status (batch 5 — Gmail collection + Gmail send)

The agent now exposes the generic five-tool orchestration contract through a
**Streamable HTTP** MCP server (official `@modelcontextprotocol/sdk`):

| Tool             | Role |
| ---------------- | ---- |
| `agent_describe` | Publishes the contract: capabilities `external-source.collect` and `communication.send-email`, executor-only (`canPlan:false`, `singleTaskOnly:true`), `defaultRequiresApproval:true`, idempotency supported. |
| `agent_plan`     | Refuses — planning is delegated to Donna. |
| `agent_execute`  | Runs a `collect` task (collector → OKF Markdown sink) or a `send` task (sender → one outbound email). Idempotent per `idempotencyKey`. |
| `agent_status`   | Task status by `jobId`, or capability status (input discovery) when no `jobId` is given. |
| `agent_cancel`   | Cooperative cancellation of a non-terminal job. |

Two direct, non-orchestrated tools support interactive clients:

| Tool | Role |
| --- | --- |
| `connectors_google_status` | Reports which Gmail grants (`read`, `send`) the active workspace holds. |
| `connectors_google_oauth_start` | Returns the Google authorization URL for the requested grants, without starting any task. |

The manager injects the active workspace into these direct tools. Served chat
allow-lists only these two connector tools; the five orchestration tools remain
runtime-only — which is also what keeps sending out of `/chat`. An email can
only be sent by an approved task in agent mode (Shell UI or `llm-wiki serve`),
never by a chat tool call.

### Sending email (`communication.send-email`)

```json
{
  "operation": "send",
  "workspace": { "name": "demo" },
  "idempotencyKey": "attempt-specific-key",
  "arguments": {
    "instanceId": "google-1",
    "to": ["dest@example.com"],
    "cc": [],
    "subject": "Rapport hebdomadaire",
    "body": "Bonjour,\n\nvoici le résumé.",
    "dryRun": false
  }
}
```

Plain text only, one message per task. `From` is never accepted: Gmail stamps
the authenticated mailbox, so a task cannot spoof a sender. Recipients, subject
and body are validated **synchronously** — a malformed request is rejected by
`agent_execute` (`invalid_arguments:*`) and no job is created, so "rejected"
can never be confused with "sent and failed". `dryRun: true` builds and
validates the message and contacts no provider.

The `send` grant is separate from the `read` grant. A workspace connected
before this batch holds only `read`; the first send fails with
`authorization_required:send`, and the user re-authorizes through
`connectors_google_oauth_start` with `{"grants":["send"]}`. Authorization is
incremental (`include_granted_scopes=true`), so adding `send` never revokes
`read`.

Send-specific failure reasons: `authorization_required:send`, `send_rejected`
(provider 4xx — terminal, retrying an identical message cannot help and is how
duplicates happen), `provider_rate_limited`, `provider_unavailable`,
`send_failed`.

When an `idempotencyKey` is supplied, the message carries a deterministic
`Message-ID` derived from it. Beyond the job store's replay protection, this is
what lets an operator search the sent mailbox (`rfc822msgid:`) after a crash and
tell "never sent" from "sent, acknowledgement lost".

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

Sending adds four variables:

| Variable | Default | Role |
| --- | --- | --- |
| `CONNECTORS_SEND_ENABLED` | `true` | Kill switch. When `false`, no sender is constructed, the capability is absent from `agent_describe`, and a `send` task is refused. |
| `CONNECTORS_SEND_ALLOWED_RECIPIENTS` | *(empty — unrestricted)* | Comma-separated allow-list of addresses or `@domain` suffixes, enforced on To, Cc **and** Bcc before the message is built. |
| `CONNECTORS_SEND_MAX_RECIPIENTS` | `25` | Ceiling on To + Cc + Bcc for one message. |
| `CONNECTORS_SEND_MAX_BODY_BYTES` | `262144` | Ceiling on the plain-text body. |

`GOOGLE_OAUTH_CALLBACK_URL` must exactly match an authorized redirect URI in
Google Cloud Console. For a local Docker installation, the manager generates
`http://127.0.0.1:<published-port>/oauth/google/callback`; the browser reaches
the agent through Docker's published host port. A remote deployment instead
uses its explicit public HTTPS URL. Never use the container hostname as a
redirect URI.

The local Desktop flow uses PKCE. Google treats an installed application as a
public client that cannot keep a secret; its generated `client_secret` is
therefore distributed with the Client ID and is not a security boundary. Both
values are baked into the official image so end users never need to create a
Google Cloud project. PKCE, OAuth `state`, user consent, and secure refresh
token storage provide the actual protections.

The wikiLLM OAuth credentials are deliberately absent from the source tree.
They live in a gitignored `.env.build.local` at the root of this repository:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
```

Both build paths load that file and forward it as `--build-arg`:
`build-and-push.sh` (which aborts unless both values are provided) and
`wiki-workspace agents up`, which exports the two
variables so Compose can resolve the value-less `build.args` of the
`connectors` service. Both supported entrypoints reject a missing or partial
pair before invoking Docker. A bare `docker build` is unsupported because it
bypasses that validation.

At runtime, `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (or
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) are administrator overrides that
take precedence over the baked-in values.

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
