# Helix prototype: design and interface

Status: stage 2 landed (coordinator, dispatch, settlement, delivery, Stop, restart, lifecycle; see
section 14). The
coordinator, provider prompts and web UI build on the interfaces fixed here. Paths are under
`apps/server/src/` unless they start with `packages/` or `apps/web/`.

## 1. What Helix is

An opt-in mode inside an ordinary chat. The chat's thread is the **Lead**: it plans, talks to the
user and reviews. The server owns one persistent **Builder** thread that works in the Lead's
worktree with its own provider session and history. The Lead delegates through gateway tools; the
server dispatches each brief to the Builder as a server-originated turn; when the Builder's turn has
settled and its output is ingested, the server finalises the result and delivers it to the Lead,
which accepts it, requests changes (a new handoff to the same Builder session) or blocks.

Fixed decisions:

- Its own mode. Not a Hub. Ordinary chats, Hubs and native sub-agents are unchanged. Everything is
  inert unless a pair row exists for the thread.
- Off by default: server setting `enableHelix` (`packages/contracts/src/settings.ts`). While off,
  `helix.*` mutations fail with `HELIX_DISABLED`; reads still work so the web can keep Builders
  hidden.
- The Builder is linked by Helix tables only. Never by `parentThreadId` (that means "native
  sub-agent sharing the parent's provider session" and reroutes leases, queues, steering and stop).
- State-table aggregate, not event-sourced (migration 143).
- Claude (`claudeAgent`) and Codex only, for both roles. Every other provider is refused with a
  specific reason (`helixRoleSupport`). Never substitute provider, model, effort or permission mode.
- No `helix_steer`. Further instructions for a running Builder go into the next handoff: the Lead
  waits, then puts them in its review's feedback (`changes_requested`).
- Deferred (design for, do not build): context manifests, combined usage, pinning results to a
  commit oid, Builder recovery packets, live steering, ACP providers.

## 2. Module map (what exists now)

| Concern                                                                 | Module                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Schemas, constants, provider support, views                             | `packages/contracts/src/helix.ts`                                                                      |
| `helix.*` RPC definitions, `WsHelixRpcGroup`                            | `packages/contracts/src/helixRpc.ts`                                                                   |
| Setting `enableHelix`                                                   | `packages/contracts/src/settings.ts`                                                                   |
| Session-start field `helixRole`                                         | `packages/contracts/src/provider.ts` (`ProviderSessionStartInput`)                                     |
| Capability string `helix.pairs`                                         | `packages/contracts/src/wsCompatibility.ts`                                                            |
| Optional `NativeApi.helix`                                              | `packages/contracts/src/ipc.ts`                                                                        |
| Request classes (stop/pause/resume = control)                           | `packages/shared/src/wsRequestClass.ts`                                                                |
| Migration                                                               | `persistence/Migrations/143_HelixPairs.ts`                                                             |
| Repository                                                              | `persistence/Services/HelixRepository.ts`, `persistence/Layers/HelixRepository.ts`                     |
| Pure state machine                                                      | `helix/stateMachine.ts`                                                                                |
| Command ids, fingerprints, id minting                                   | `helix/identity.ts`                                                                                    |
| Wire views                                                              | `helix/views.ts`                                                                                       |
| RPC service (foundation: reads real, mutations `HELIX_NOT_IMPLEMENTED`) | `helix/Services/HelixService.ts`, `helix/Layers/HelixService.ts`                                       |
| Gateway port the tools call                                             | `helix/Services/HelixGatewayPort.ts`                                                                   |
| Gateway tools                                                           | `agentGateway/helixTools.ts`                                                                           |
| Role-exclusive capabilities                                             | `agentGateway/Layers/AgentGatewaySessionRegistry.ts`, `agentGateway/Layers/AgentGatewayCredentials.ts` |

## 3. Storage (migration 143 `HelixPairs`)

Registered as `[143, "HelixPairs", Migration0143]` in `persistence/Migrations.ts`. Idempotent (all
`IF NOT EXISTS`). Later Helix schema changes are new migrations (144+), never edits to 143.

```sql
helix_pairs (
  pair_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  lead_thread_id TEXT NOT NULL UNIQUE,
  builder_thread_id TEXT NOT NULL UNIQUE,
  builder_created_at TEXT,                 -- null until the Builder thread exists
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','disabled')),
  revision INTEGER NOT NULL,               -- aggregate CAS revision
  cancellation_epoch INTEGER NOT NULL,
  hold_json TEXT,                          -- HelixHold | NULL
  goal_json TEXT NOT NULL,                 -- HelixGoal
  config_json TEXT NOT NULL,               -- HelixPairConfig
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (lead_thread_id <> builder_thread_id))

helix_handoffs (
  handoff_id TEXT PRIMARY KEY, pair_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,               -- 1-based per pair
  request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
  work_item_id TEXT NOT NULL, previous_handoff_id TEXT,
  correction_index INTEGER NOT NULL, goal_seq INTEGER NOT NULL, epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (...11 states...), delivery TEXT NOT NULL CHECK (...7 states...),
  revision INTEGER NOT NULL,
  dispatch_command_id TEXT, wake_command_id TEXT, builder_turn_id TEXT,
  record_json TEXT NOT NULL,               -- the full HelixHandoff
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (pair_id, request_id), UNIQUE (pair_id, sequence))

UNIQUE INDEX idx_helix_handoffs_one_active ON helix_handoffs(pair_id)
  WHERE state IN ('prepared','dispatching','running')        -- one Builder slot per pair
UNIQUE INDEX idx_helix_handoffs_dispatch_command (dispatch_command_id) WHERE NOT NULL
UNIQUE INDEX idx_helix_handoffs_wake_command (wake_command_id) WHERE NOT NULL
INDEX idx_helix_handoffs_unresolved (pair_id, state) WHERE state IN (prepared, dispatching, running,
  awaiting_review) OR delivery IN ('pending','wake_requested')
```

Typed columns hold what the server queries or constrains; `*_json` holds contract-shaped payloads
decoded with the `@synara/contracts` Helix schemas. One pair row per Lead thread, ever: disable sets
`lifecycle = 'disabled'`, re-enable reactivates the same row and the same Builder. A thread is in at
most one pair, in one role (checked by `createPair`).

### Repository (`HelixRepository`)

| Method                                                                                                    | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPair(pair)`                                                                                        | Revision must be 0. `participant_conflict` if either thread is in any pair, either role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getPair(id)`, `getPairByLeadThread(threadId)`, `listPairs()`                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `getParticipant(threadId)`                                                                                | `{ pair, role: "lead" \| "builder" } \| null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `commit({ pair, expectedRevision, handoffs })`                                                            | One transaction. `pair.revision` must equal `expectedRevision + 1`; the row must still be at `expectedRevision` (`stale_revision`, or `not_found`). Each write is `{kind:"insert", handoff}` (revision 0) or `{kind:"update", handoff, expectedRevision}` (handoff revision must advance by one; `stale_handoff_revision`). Inserts with an existing request id fail `duplicate_request` (same fingerprint; carries `existingHandoffId`) or `request_conflict`. Any write that would leave two active handoffs fails `active_handoff_exists`. Any failure rolls the whole commit back. |
| `getHandoff`, `findHandoffByRequestId(pairId, requestId)`, `listHandoffs(pairId, {limit})` (newest first) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `listUnresolvedHandoffs()`                                                                                | prepared/dispatching/running/awaiting_review or delivery pending/wake_requested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `findAutomaticTurn(commandId)`                                                                            | `{ kind: "dispatch" \| "wake", pair, handoff } \| null` for the handoff whose CURRENT intent carries that command id. A superseded attempt returns null.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deletePair(pairId)`                                                                                      | Pair and handoffs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Error type `HelixRepositoryError` with `code` in: `storage`, `not_found`, `stale_revision`,
`stale_handoff_revision`, `duplicate_request`, `request_conflict`, `active_handoff_exists`,
`participant_conflict`.

## 4. Contract types (`packages/contracts/src/helix.ts`)

- Ids: `HelixPairId` (≤128), `HelixHandoffId` (≤96, so `correction:<id>` fits a request id),
  `HelixRequestId` (≤128, `^[A-Za-z0-9][A-Za-z0-9._:-]*$`). Minted by `helix/identity.ts`:
  `helix-pair:<uuid>`, `helix-handoff:<uuid>`.
- `HelixRole = "lead" | "builder"`.
- `HelixPair { id, projectId, leadThreadId, builderThreadId, builderCreatedAt, lifecycle, revision,
cancellationEpoch, hold, goal, config, createdAt, updatedAt }`.
- `HelixHold { kind: "stop"|"pause"|"limit"|"restart"|"uncertain", reason, limit:
"goal_dispatches"|"work_item_corrections"|null, handoffId|null, epoch, since }`.
- `HelixGoal { seq, sourceMessageId, startedAt, dispatchCount, dispatchBudget }`.
- `HelixPairConfig { builderModelSelection: ModelSelection, builderRuntimeMode: RuntimeMode,
limits: HelixLimits, rolePromptVersions: { lead, builder } }`. Defaults:
  `DEFAULT_HELIX_LIMITS = { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 20 }`.
- `HelixHandoff { id, pairId, sequence, requestId, requestFingerprint, workItemId,
previousHandoffId, correctionIndex, goalSeq, epoch, state, delivery, revision, brief, dispatch,
dispatchAttempts, builderTurnId, report, result, lateResult, review, wake, wakeAttempts, failure,
createdAt, updatedAt }`.
- `HelixBrief` (stored) = `HelixBriefInput { title, objective, context?, scope?, constraints?,
acceptanceCriteria, verification?, runtimeNotes? }` + `correction? { previousHandoffId,
previousResultRevision, feedback }`.
- `HelixStoredReport` = `HelixBuilderReport { outcome: completed|partial|blocked|failed, summary,
changes?, verification?, deviations?, blockers?, followUps? }` + `reportRevision, builderTurnId,
submittedAt`.
- `HelixBuilderResult { revision, turnOutcome: completed|failed|interrupted, outcome:
completed|partial|blocked|failed|interrupted, source: report|final_message|none, summary, ...,
builderTurnId, finalizedAt }`. A candidate, not verified work. Without a report the outcome of a
  completed turn is `partial`: the server cannot claim completion.
- `HelixReview { requestId, verdict: accepted|changes_requested|blocked, feedback,
reviewedResultRevision, nextHandoffId, reviewedAt }`. "Accepted" is the Lead's judgement; it is
  not a human review mark and grants nothing.
- `HelixTurnIntent { commandId, messageId, createdAt, attempt }`: frozen per attempt. Reuse
  `createdAt` verbatim as the command's `createdAt` (the receipt fingerprint includes it).
- Views: `HelixPairSummary { pairId, projectId, leadThreadId, builderThreadId, lifecycle, status,
hold, activeHandoffId, revision, updatedAt }`, `HelixPairView { summary, pair, handoffs (newest
first, ≤50) }`, `helixPairDisplayStatus(pair, latest)` → `idle | building | reviewing |
needs_attention | paused | stopped | disabled`. Built by `helix/views.ts`.
- Provider support: `helixRoleSupport(provider, role)` → `{supported:true}` for `codex` and
  `claudeAgent`; otherwise `{supported:false, reason: "Unsupported in this version: ..."}`.

Compatibility: every union above is new and travels only on `helix.*`. Adding a literal later needs
a new capability string (e.g. `helix.pairs.v2`), because an older client would fail to decode it.
`enableHelix` is additive: Effect structs ignore unknown keys on decode (checked), so older clients
and servers drop it.

## 5. State machines (`helix/stateMachine.ts`)

`transitionHelix(aggregate, command) → { ok:false, error } | { ok:true, changed, replayed, pair,
expectedRevision, writes, effects, handoff }`. Pure: commands carry `now` and pre-generated ids. The
coordinator loop is: load the aggregate, transition, `repository.commit({ pair, expectedRevision,
handoffs: writes })` if `changed`, publish stream events, then perform `effects`. On
`stale_revision`, reload and retry. Never hold a transaction or lock while awaiting an agent.
Aggregate contract: include every non-terminal handoff, every handoff with delivery pending or
wake_requested, the latest handoff, the named handoff, and (for `delegate`) the handoff holding the
request id (`findHandoffByRequestId`).

`createHelixPair(input)` builds the revision-0 pair, refusing unsupported providers
(`unsupported_provider`) and a thread paired with itself.

### Pair

| Field               | Rules                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`         | `active` ⇄ `disabled` via `disable` (only with no active handoff; epoch+1, hold cleared, pending deliveries suppressed) and `enable`.                                                                                                                                |
| `cancellationEpoch` | +1 on every `stop` and on `disable`. Handoffs record the epoch they were created in. Dispatch, wake and pending delivery require `handoff.epoch === pair.cancellationEpoch`.                                                                                         |
| `hold`              | Any hold suppresses every automatic dispatch and wake. Set by `stop` (`stop`), `pause` (`pause`), limits (`limit`), restart reconciliation (`restart`) and uncertain sends (`uncertain`). Precedence when several apply: stop > uncertain > existing hold > restart. |
| `goal`              | `user_message` starts a new goal: `seq+1`, `dispatchCount = 0`, `dispatchBudget = maxDispatchesPerGoal`.                                                                                                                                                             |

Hold release:

| Hold        | `resume` (explicit)                                                        | New user-origin message to the Lead |
| ----------- | -------------------------------------------------------------------------- | ----------------------------------- |
| `stop`      | releases                                                                   | releases                            |
| `limit`     | releases; `goal_dispatches` also adds `maxDispatchesPerGoal` to the budget | releases (new goal)                 |
| `restart`   | releases                                                                   | releases                            |
| `pause`     | releases                                                                   | stays                               |
| `uncertain` | releases (the uncertain handoff stays `uncertain`, never resent)           | stays                               |

On release: the prepared handoff (if any, current epoch) gets `dispatch_ready`; pending deliveries of
the current epoch get `deliver_result`. A user message first cancels prepared handoffs whose
`goalSeq` is older than the new goal (the new message did not authorise them).

### Handoff states

`prepared → dispatching → running → awaiting_review → accepted`; also `changes_requested`,
`blocked`, `failed`, `interrupted`, `cancelled`, `uncertain` (all terminal). Only `prepared`,
`dispatching`, `running` occupy the pair's single slot (DB-enforced).

| Command                                                                                                    | From → to                                                                                                                       | Guards (error code)                                                                                                                                                                                                                  | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `delegate{handoffId, requestId, fingerprint, brief}`                                                       | — → prepared                                                                                                                    | same requestId: same fingerprint = replay (`replayed:true`, no change); else `request_conflict`. Then `pair_disabled`, `pair_held`, `handoff_active`, `review_pending` (a handoff awaits review).                                    | `dispatch_ready{needsBuilderThread}`; or, if the goal budget is spent, hold `limit/goal_dispatches` and no dispatch.                                                                                                                                                                                                                                                                                                                                                                 |
| `builder.created`                                                                                          | sets `builderCreatedAt`                                                                                                         | —                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dispatch.start{handoffId, messageId}`                                                                     | prepared → dispatching                                                                                                          | `invalid_transition`, `pair_disabled`, `pair_held`, `stale_epoch`, `builder_missing`, `limit_reached`                                                                                                                                | Freezes `dispatch = {commandId: helix:dispatch:<id>:<attempt>, messageId, createdAt: now, attempt}`; `dispatchCount+1`.                                                                                                                                                                                                                                                                                                                                                              |
| `dispatch.acknowledged{commandId, builderTurnId}`                                                          | dispatching → running                                                                                                           | `command_mismatch`; late ack on a closed handoff is a no-op                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dispatch.failed{commandId, reason}`                                                                       | dispatching/running → failed                                                                                                    | `command_mismatch`                                                                                                                                                                                                                   | delivery pending → `deliver_result`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dispatch.uncertain{commandId, reason}`                                                                    | → uncertain                                                                                                                     | `command_mismatch`                                                                                                                                                                                                                   | delivery `suppressed`; hold `uncertain` (unless stopped). Never resent.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dispatch.suppressed{commandId}`                                                                           | dispatching → prepared                                                                                                          | no-op unless it is the current attempt                                                                                                                                                                                               | `dispatch = null`, `dispatchCount-1`. Next dispatch uses attempt+1 (new command id).                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dispatch.abandoned{handoffId, reason}`                                                                    | prepared/dispatching → failed                                                                                                   | —                                                                                                                                                                                                                                    | The engine refused the Builder creation or the brief (e.g. an unsupported model): delivery pending → `deliver_result`, so the Lead learns why.                                                                                                                                                                                                                                                                                                                                       |
| `report.submit{builderTurnId, report}`                                                                     | running/dispatching (unchanged state)                                                                                           | `no_running_handoff`, `stale_epoch`, `turn_mismatch` (a bound turn differs)                                                                                                                                                          | Stores the draft, `reportRevision+1`. Last one wins. Does not bind `builderTurnId`: the coordinator first checks the caller turn against the turn the brief started (`findTurnForMessage`) and binds through `dispatch.acknowledged`.                                                                                                                                                                                                                                                |
| `turn.settled{handoffId, builderTurnId, turnOutcome, finalMessage}`                                        | running/dispatching → awaiting_review / failed / interrupted                                                                    | `invalid_transition` (prepared), `turn_mismatch`                                                                                                                                                                                     | Result from the report only when the report's turn is unbound, the handoff's is unbound, or they match; else final message, else none. Delivery `pending` (current epoch, not stopped) → `deliver_result{wakeAllowed: no hold}`; else `suppressed`. On an already closed handoff: an identical replay is a no-op; otherwise stored as `lateResult` with `lateResultReason` (`uncertain_send` if it was `uncertain`, `stop` if the epoch moved, else `interrupted`), never delivered. |
| `result.returned`                                                                                          | delivery pending → returned_in_tool                                                                                             | `invalid_transition` (lost the race)                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `wake.request{messageId}`                                                                                  | delivery pending → wake_requested                                                                                               | `invalid_transition`, `pair_disabled`, `pair_held`, `stale_epoch`                                                                                                                                                                    | Freezes `wake = {commandId: helix:wake:<id>:<attempt>, ...}`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `wake.dispatched{commandId}`                                                                               | wake_requested → wake_dispatched                                                                                                | stale command = no-op                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `wake.suppressed{commandId}`                                                                               | wake_requested or wake_dispatched → pending (current, not stopped) or suppressed                                                | stale command = no-op                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `review{handoffId, requestId, verdict, feedback, expectedResultRevision?, nextHandoffId, nextFingerprint}` | awaiting_review → accepted / changes_requested / blocked; failed/interrupted → changes_requested / blocked                      | reviewed: same requestId + same content = replay, same requestId + different = `request_conflict`, other requestId = `invalid_transition`; `feedback_required`; `stale_result`; changes_requested: `pair_disabled`, `handoff_active` | delivery pending → acknowledged. changes_requested inserts the correction (requestId `correction:<reviewedId>`, same `workItemId`, `correctionIndex+1`, brief + `correction`). Past `maxCorrectionsPerWorkItem` → hold `limit/work_item_corrections` (the correction stays prepared); else `dispatch_ready` (subject to the goal budget and any hold). Allowed under a hold.                                                                                                         |
| `stop`                                                                                                     | prepared → cancelled; dispatching/running → interrupted (delivery suppressed); other pending deliveries → suppressed            | none: Stop always wins; no-op on a disabled pair                                                                                                                                                                                     | epoch+1, hold `stop`; `interrupt_participants{lead, builder, builderHadWork}` (the Builder is interrupted even before a turn is visible when it had work), `cancel_waits{epoch}`.                                                                                                                                                                                                                                                                                                    |
| `pause{expectedRevision}` / `resume{expectedRevision}`                                                     | hold set / released                                                                                                             | `stale_revision`, `pair_disabled`; pause over another hold `pair_held`; resume without one `not_held`                                                                                                                                | resume: see release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `disable` / `enable{expectedRevision}`                                                                     | lifecycle                                                                                                                       | `stale_revision`, `handoff_active` (disable)                                                                                                                                                                                         | disable: `cancel_waits`, `archive_builder_thread`, `update_role_profiles`. enable: `unarchive_builder_thread`, `update_role_profiles`.                                                                                                                                                                                                                                                                                                                                               |
| `config.update{expectedRevision, builderModelSelection?, limits?}`                                         | config                                                                                                                          | `stale_revision`, `handoff_active` (anything active or awaiting review), `unsupported_provider`                                                                                                                                      | `restart_builder_session` when the model changed.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `user_message{messageId}`                                                                                  | goal                                                                                                                            | — (no-op when disabled)                                                                                                                                                                                                              | see release; `deliver_result` for current-epoch pending results.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `restart.reconcile{evidence}`                                                                              | dispatching → prepared (`not_sent`) / running (`turn_started`) / uncertain (`send_uncertain` or missing); running stays running | —                                                                                                                                                                                                                                    | hold `uncertain` or `restart` when anything was unresolved. Never dispatches or wakes. A running Builder turn is not closed: its real outcome settles it later, under the hold.                                                                                                                                                                                                                                                                                                      |

Effects: `dispatch_ready`, `deliver_result`, `interrupt_participants`, `cancel_waits`,
`update_role_profiles`, `archive_builder_thread`, `unarchive_builder_thread`,
`restart_builder_session`.

## 6. Gateway roles and tools

### Role-exclusive capability mechanism

`AgentGatewaySessionRegistry` keeps a per-thread role profile:

```ts
type AgentGatewayRoleProfile =
  | { kind: "helix_lead"; pairId: string }
  | { kind: "helix_builder"; pairId: string };
registry.setThreadRoleProfile(threadId, profile | null); // also on AgentGatewayCredentials
registry.getThreadRoleProfile(threadId);
agentGatewayCapabilitiesForRoleProfile(granted, profile); // the one derivation
```

- No profile: unchanged (`thread:read`, `thread:write`, `automation:write`, `diagnostics:read`,
  `browser:control`, `device:control`, plus requested additions).
- `helix_lead`: the normal set plus `helix:lead`.
- `helix_builder`: exactly `{ helix:builder }`. Base capabilities, requested additions (including
  `computer:control`) and MCP connectors are withheld (`makeAgentGatewayConnectorRegistry` grants
  none and refuses earlier grants).
- Applied at `issue` and at every `verify`, so credentials issued before the profile was set (or
  after it changed) always reflect the current assignment. Identity carries `roleProfile`.
- Caller identity comes only from the bearer; the thread's role only from the profile, which only
  Helix sets from its tables. Tool arguments never name a role, pair or thread.
- Startup: `HelixServiceFoundationLive` re-applies every stored participant's profile while it is
  built, and `AgentGatewayLive` is provided after it (`serverLayers.ts`), so no MCP request is
  served before Builders are restricted. A Builder stays `helix_builder` even when its pair is
  disabled.
- Verified: ordinary, Hub coordinator and Hub worker sessions list exactly the tools they listed
  before this change (snapshot comparison of all harness tokens), and list no `helix_*` tool.

### Tools (`agentGateway/helixTools.ts`, schemas in `helix.ts`)

| Tool             | Capability      | Active turn | Input                                                                                            | Output                                                                                                                 |
| ---------------- | --------------- | ----------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `helix_delegate` | `helix:lead`    | yes         | `HelixDelegateToolInput { requestId, brief: HelixBriefInput, waitSeconds? (0..60, default 30) }` | `HelixHandoffWaitOutput { pairId, handoff: HelixHandoffToolView, replayed, timedOut, hold, message }`                  |
| `helix_wait`     | `helix:lead`    | yes         | `{ handoffId?, waitSeconds? }` (default: active, else latest)                                    | `HelixHandoffWaitOutput`                                                                                               |
| `helix_inspect`  | `helix:lead`    | no          | `{ handoffId?, recent? (0..20) }`                                                                | `HelixInspectToolOutput { pairId, builderThreadId, status, hold, goal, limits, handoff (with brief, report), recent }` |
| `helix_review`   | `helix:lead`    | yes         | `{ handoffId, requestId, verdict, feedback?, expectedResultRevision?, waitSeconds? }`            | `HelixReviewToolOutput { pairId, handoffId, verdict, replayed, next: HelixHandoffWaitOutput \| null, hold, message }`  |
| `helix_report`   | `helix:builder` | yes         | `HelixBuilderReport`                                                                             | `HelixReportToolOutput { handoffId, reportRevision, message }`                                                         |

Errors are MCP tool errors `{ error: { code, message, details? } }`. Codes
(`HELIX_TOOL_ERROR_CODES`): `helix_disabled`, `helix_not_implemented`, `helix_invalid_input`,
`helix_no_pair`, `helix_pair_disabled`, `helix_pair_held`, `helix_handoff_active`,
`helix_review_pending`, `helix_request_conflict`, `helix_handoff_not_found`,
`helix_invalid_transition`, `helix_stale_result`, `helix_feedback_required`,
`helix_no_running_handoff`. A missing capability is the gateway's existing `capability_denied`.
Map state-machine codes: `pair_held → helix_pair_held`, `handoff_active`, `review_pending`,
`request_conflict`, `handoff_not_found`, `stale_result`, `feedback_required`, `no_running_handoff`
→ the same name with `helix_`; `pair_disabled → helix_pair_disabled`; everything else →
`helix_invalid_transition`.

Handlers decode with the contract schemas and call `HelixGatewayPort` with `HelixToolCaller {
threadId, turnId, sessionKey, provider, role }`. The coordinator must re-resolve the role from
`getParticipant(threadId)` and refuse a mismatch (`helix_no_pair`). Until the coordinator provides
`HelixGatewayPort`, every call returns `helix_not_implemented`. The tool names are in
`SYNARA_GATEWAY_OWNED_TOOL_NAMES` (`agentGateway/computerToolPermission.ts`). Auto-approval is
role-exact (see section 15).

Wait semantics: block up to `waitSeconds` for the handoff to leave the slot with a finalised result.
If it arrives in time and `result.returned` wins the CAS, return it (`timedOut:false`); otherwise
return the handoff with `timedOut:true` and let delivery wake the Lead later. Only the CAS winner
gets the result; a later `helix_wait` on a result already returned (in a tool or by a wake) gets the
handoff without the result and "Not a new result: handoff N was already delivered to you", so a
woken result is never presented twice. `cancel_waits` fails
waiters with `helix_pair_held`. Interrupting the Lead's turn cancels its waiter (gateway in-flight
registry); the result then stays `pending` for a wake.

## 7. RPC surface and how state reaches the web

Satellite group `WsHelixRpcGroup` (`packages/contracts/src/helixRpc.ts`), merged into the admitted
server group in `wsRpc.ts` and advertised as `helix.pairs`. Errors are `WsRpcError` with `code` from
`HELIX_RPC_ERROR_CODES`: `HELIX_DISABLED`, `HELIX_UNAVAILABLE`, `HELIX_NOT_IMPLEMENTED`,
`HELIX_NOT_FOUND`, `HELIX_STALE_REVISION`, `HELIX_CONFLICT`, `HELIX_INVALID_TRANSITION`,
`HELIX_UNSUPPORTED_PROVIDER`, `HELIX_UNSUPPORTED_THREAD`, `HELIX_PAIR_BUSY`.

| Method                         | Payload                                                               | Success                                                                                   | Admission / rules                                                                           | Now           |
| ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| `helix.capabilities`           | `{}`                                                                  | `{ enabled, providers: [{provider, lead, builder: {supported, reason}}], defaultLimits }` | any session                                                                                 | real          |
| `helix.listPairs`              | `{}`                                                                  | `{ pairs: HelixPairSummary[] }` (active and disabled)                                     | any session                                                                                 | real          |
| `helix.getPair`                | `{ leadThreadId }`                                                    | `HelixPairView \| null`                                                                   | any session                                                                                 | real          |
| `helix.enable`                 | `{ leadThreadId, builderModelSelection, limits?, expectedRevision? }` | `HelixPairView`                                                                           | owner only; `expectedRevision` required to re-enable a disabled pair, omitted for a new one | stub          |
| `helix.disable`                | `{ pairId, expectedRevision }`                                        | `HelixPairView`                                                                           | owner only                                                                                  | stub          |
| `helix.updateConfig`           | `{ pairId, expectedRevision, builderModelSelection?, limits? }`       | `HelixPairView`                                                                           | owner only; idle pairs only                                                                 | stub          |
| `helix.pause` / `helix.resume` | `{ pairId, expectedRevision }`                                        | `HelixPairView`                                                                           | any admitted session; control class                                                         | stub          |
| `helix.stop`                   | `{ pairId }`                                                          | `HelixPairView`                                                                           | any admitted session; control class; no revision (Stop always wins)                         | stub          |
| `helix.subscribe`              | `{ leadThreadId? }`                                                   | stream of `HelixStreamEvent`                                                              | stream admission key `helix.events:<leadThreadId or *>`                                     | snapshot only |

Mutations fail `HELIX_DISABLED` while `enableHelix` is off; stale revisions fail
`HELIX_STALE_REVISION` (state-machine `stale_revision`). Map `pair_held`/`handoff_active` →
`HELIX_PAIR_BUSY`, `unsupported_provider` → `HELIX_UNSUPPORTED_PROVIDER`, refused thread kinds →
`HELIX_UNSUPPORTED_THREAD`, everything else → `HELIX_INVALID_TRANSITION`.

Stream (Hub precedent: `projectAgent.subscribe`): the first event is always `snapshot { pairs, view
}` (`view` when `leadThreadId` is given and has a pair). Then, after every committed transition, the
coordinator publishes `pair-upserted { summary }` to every subscription and `handoff-upserted {
handoff }` for each written handoff to subscriptions scoped to that pair's Lead; `pair-removed
{ pairId, leadThreadId, builderThreadId }` when a pair is deleted. Publish after the commit returns
and before running effects. No new push channel: an old client would fail to decode one in `WsPush`.

## 8. Hook points for later stages

| Hook                                                 | Where                                                                                                                                                                                                                                                                                                                                                                              | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder thread creation in the Lead's worktree       | new `helix/coordinator` calling `OrchestrationEngineService.dispatch({ type: "thread.create", ... })` (decider `thread.create`, `orchestration/decider.ts`)                                                                                                                                                                                                                        | `threadId = pair.builderThreadId`, same `projectId`, `envMode`, `branch`, `worktreePath`, `workingDirectory` and `associatedWorktree*` as the Lead, `parentThreadId: null`, no `creationSource`/`sourceThreadId`, `modelSelection = config.builderModelSelection`, `runtimeMode = config.builderRuntimeMode`, title `Builder · <Lead title>`. The setup script runs only on worktree creation, so it does not rerun. Command id `helix:create-builder:<pairId>`; then `builder.created`.                                                                                                                                                                                                                                                                                                    |
| Dispatch to the Builder                              | coordinator, on `dispatch_ready`                                                                                                                                                                                                                                                                                                                                                   | `dispatch.start` (commit) → `thread.turn.start { commandId: dispatch.commandId, threadId: builder, message: { messageId: dispatch.messageId, role: "user", text: renderBrief(brief) }, dispatchOrigin: "agent", dispatchMode: "queue", runtimeMode, interactionMode: "default", createdAt: dispatch.createdAt }`. Accepted → `dispatch.acknowledged` (turn id when known); rejected → `dispatch.failed`; delivery journal `uncertain` → `dispatch.uncertain`. Always `queue`: non-native `steer` interrupts.                                                                                                                                                                                                                                                                                |
| Builder turn settlement                              | new `helix/Layers/HelixReactor.ts` on `OrchestrationEngineService.streamDomainEvents` (copy `projectAgent/Layers/ProjectAgentReactor.ts` `SETTLE_EVENT_TYPES`)                                                                                                                                                                                                                     | For the Builder thread: on a terminal event for `handoff.builderTurnId`, wait until `completionRepository.isOutputSettled(builderThreadId)` (`agentGateway/completionRepository.ts`), read the final assistant message, then `turn.settled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Lead wake                                            | coordinator, on `deliver_result` with no waiter                                                                                                                                                                                                                                                                                                                                    | `wake.request` (commit) → `thread.turn.start { commandId: wake.commandId, threadId: lead, dispatchOrigin: "agent", dispatchMode: "queue", createdAt: wake.createdAt, text: renderResult(result) }` → `wake.dispatched`. A new turn: write authority is retired per turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lead tools auto-approve and role instructions        | `orchestration/Layers/ProviderCommandReactor.ts` `ensureSessionForThread` (where `autoApproveSynaraTools` and `providerSessionOptions` are built)                                                                                                                                                                                                                                  | For participants: `helixRole = { role, pairId, promptVersion, instructions }` from `helix/rolePrompts.ts`; `autoApproveSynaraTools: true` for both roles. Add a `helixRoleChanged` restart condition next to `autoApproveSynaraToolsChanged`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Gate on every server turn on a participant           | PCR `processTurnStartRequestedWithoutLease` before any provider call (also covers queued turns at promotion, whose command id is `server:dispatch-queued-turn:*`, so the gate matches message ids); again in `sendQueuedProviderTurn` immediately before `providerService.sendTurn`; and once the turn id is bound (interrupt with `controlRequestId: helix-stale:<turnStartKey>`) | Applies when the message id is a Helix id (`parseHelixMessageId`) or the thread is a participant (`roleOf`). Admission: `admitAutomaticTurn` (records `dispatch.suppressed` / `wake.suppressed`; the projected `starting` session is returned to rest). Pre-send and post-bind: `shouldSendServerTurn` (same decision, no side effects). Helix ids: current intent, wake only before review, pair active, not quarantined, no hold, current epoch, setting on. Other turns: user turns admitted except on an active Builder; a Builder runs no other server turn (automations, goal continuation, usage-limit recovery, quit-resume); a stopped or quarantined Lead runs no server turn. Fails closed. Usage-limit recovery is also never armed for a Builder (`ProviderRuntimeIngestion`). |
| User Stop interception                               | `wsRpc.ts` `[ORCHESTRATION_WS_METHODS.dispatchCommand]`: `interceptClientCommand` before `dispatchOrchestrationCommand`, its `afterAccepted` after                                                                                                                                                                                                                                 | Client `thread.turn.interrupt` or `thread.session.stop` on a Lead or Builder → `stop` best-effort (a Helix failure never blocks the user's command), interrupting the other participant (`requestedBy: "system"`, command id `helix:stop:<pairId>:<epoch>:<threadId>`). The user's command is always dispatched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| User-origin message releases the hold, starts a goal | same handler, client `thread.turn.start` / `thread.message.edit-and-resend` on a Lead                                                                                                                                                                                                                                                                                              | `user_message { messageId }` runs in `afterAccepted`, only once the engine accepted the command. On an active Builder: refuse with `HELIX_UNSUPPORTED_THREAD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Startup reconciliation                               | `HelixReactor` construction (Hub precedent `reconcilePendingWakes`)                                                                                                                                                                                                                                                                                                                | For each `listUnresolvedHandoffs()` row: apply `turn.settled` for Builder turns that already settled (`hasCompletedRun` + `isOutputSettled`); resolve `wake_requested` via command receipts (`wake.dispatched` / `wake.suppressed`); classify `dispatching` by the dispatch command's receipt and delivery journal (`not_sent` / `send_uncertain` / `turn_lost`); then `restart.reconcile`. Quit-resume (`orchestration/quitResume.ts` `planQuitResumeTurns`) already skips agent-origin turns, so nothing is replayed.                                                                                                                                                                                                                                                                     |
| Sidebar hiding                                       | `apps/web/src/components/Sidebar.logic.ts` beside `excludeHiddenProjectAgentCoordinatorThreads`; callers `Sidebar.tsx`, `hooks/useActivityThreads.ts`                                                                                                                                                                                                                              | Hide every `builderThreadId` from `helix.listPairs` (active and disabled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Archive                                              | decider `thread.archive` cascades only through `parentThreadId`; coordinator on `thread.archived`                                                                                                                                                                                                                                                                                  | Archiving the Lead: `stop`, then archive the Builder (`helix:archive-builder:<pairId>`). Unarchive the Lead: unarchive the Builder; the hold stays. Archiving the Builder alone: refuse in `dispatchCommand` (open question 3). Worktree pruning (`managedWorktrees.ts` `archivedWorktreeHasNoOtherOwners`) must treat the pair as one owner.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Delete                                               | `orchestration/Layers/ThreadDeletionReactor.ts` (`processThreadDeleted`)                                                                                                                                                                                                                                                                                                           | Deleting the Lead: `stop`, delete the Builder thread, then `deletePair` and publish `pair-removed`. Deleting the Builder alone: refuse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Retention                                            | `threadRetention.ts` `runThreadRetentionSweep` → `getRetentionArchiveRootIds(readModel, now, protectedThreadIds)`                                                                                                                                                                                                                                                                  | Pass Builder ids as protected; archive the Builder only together with its Lead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Idle reaper                                          | `provider/Layers/ProviderSessionReaper.ts`                                                                                                                                                                                                                                                                                                                                         | May stop an idle Builder session; the next dispatch resumes it with a fresh credential (role re-applied). No change needed; do not reap a Builder with a running handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Branch-rename guard                                  | PCR `maybeGenerateAndRenameWorktreeBranchForFirstTurn` (and `renameTemporaryWorktreeBranch`)                                                                                                                                                                                                                                                                                       | Skip for Builder threads: the branch belongs to the Lead. Also skip `maybeGenerateAndRenameThreadTitleForFirstTurn` for Builders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `thread.meta.update` guard                           | `wsRpc.ts` `dispatchCommand` (clients) and `agentGateway/Layers/AgentGateway.ts` `assertCallerMayDriveThread` (agents)                                                                                                                                                                                                                                                             | Refuse workspace fields (`envMode`, `branch`, `worktreePath`, `workingDirectory`, `associatedWorktree*`, `parentThreadId`, `handoff`) on a Builder. `assertCallerMayDriveThread` must refuse any non-Helix tool that targets a Builder (send, interrupt, archive, title, goal), including from its own Lead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Hand off / provider switch                           | wsRpc `gitHandoffThread` and PCR `applyProviderHandoff`                                                                                                                                                                                                                                                                                                                            | Refuse for both participants while the pair is active (prototype).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 9. What the provider agent needs

- Field: `ProviderSessionStartInput.helixRole?: ProviderHelixRoleContext { role: "lead" | "builder",
pairId, promptVersion (≤64), instructions (≤16,000) }` (`packages/contracts/src/provider.ts`).
  Set only by PCR `ensureSessionForThread`. It carries no authority.
- How an adapter learns the role: only from `input.helixRole` at start or resume. Capabilities come
  from the credential, never from this field, so adapters keep passing the start input to
  `acquireAgentGatewaySessionLease` unchanged.
- Delivery: Claude appends `instructions` to `systemPrompt.append`
  (`buildEmbeddedClaudeSystemPromptAppend`, `provider/Layers/ClaudeAdapter.ts`); Codex composes
  them into `developer_instructions` (`buildCodexCollaborationMode`, `codexAppServerManager.ts`),
  which today returns `undefined` when there is no interaction mode and no computer control: Helix
  must still deliver the text there or through thread-start developer instructions. Once per
  runtime; never re-appended per handoff.
- Text to vary per role:
  - `buildEmbeddedClaudeSystemPromptAppend`: the "When spawning subagents ... worker-<tier>" and
    model/effort lines. Builder: discourage native sub-agents. Lead: keep, but delegate
    implementation through `helix_delegate`.
  - `buildClaudeSdkSubagents`: omit the `worker-*` agents for a Builder.
  - `agentGateway/harnessPolicy.ts` `renderSynaraHarnessPolicy`: a Builder must not be told to use
    `synara_*` thread tools ("Use the synara\_\* tools...", "For results, repeat
    synara_wait_for_threads... Await native subagents", Hub role lines). Render a Builder variant
    that names only `helix_report`; a Lead variant that adds the Helix rules.
  - `CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS` / `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS`: same.
- Prompt texts live in a new `helix/rolePrompts.ts` exporting `HELIX_ROLE_PROMPT_VERSION` and
  `renderHelixRoleInstructions(role, { builderThreadId?, leadTitle? })`. The pair pins the version in
  `config.rolePromptVersions` at enable; upgrade only when idle.
- `helixRoleSupport` is the only qualification check; never fall back to another provider or model.

## 10. What the web agent needs

- Gate on the `helix.pairs` capability; merge `WsHelixRpcGroup` in `apps/web/src/wsTransport.ts`
  (next to `WsProjectAgentRpcGroup`) and implement `NativeApi.helix` in `apps/web/src/wsNativeApi.ts`.
- Render: pair `summary.status` and `hold.reason`; handoffs (`brief`, `state`, `result`, `review`,
  `failure`, `lateResult` labelled "arrived after Stop"); `builderThreadId` for the transcript link;
  `goal.dispatchCount / dispatchBudget` and limits. "Lead accepted" must look different from any
  human review.
- Controls: enable (Builder model picker), Pause, Resume, Stop, disable, idle reconfiguration. Pass
  `expectedRevision = summary.revision`; on `HELIX_STALE_REVISION` reload.
- Extend: `components/chat/SubagentRunCard.tsx` / `SubagentThreadIntro.tsx` (Builder activity and
  intro), `components/chat/group/HubWorkItemCard.tsx` (handoff cards),
  `components/chat/group/GroupModelEffortRow.tsx` with `components/chat/ProviderModelPicker.tsx`
  (Builder provider/model/effort), `components/chat/group/GroupPausedBanner.tsx` (held banner),
  `ThreadStatusPill` in `components/Sidebar.logic.ts`, `excludeHiddenProjectAgentCoordinatorThreads`
  (hide Builders), and `components/settings/UsageLimitRecoverySetting.tsx` as the pattern for an
  `enableHelix` toggle.

## 11. File ownership for the next stage

Contracts are frozen for the stage. `packages/contracts/src/helix.ts`, `helixRpc.ts`, the
`enableHelix` setting, `helixRole` and `NativeApi.helix` already hold everything the three agents
need. Only the coordinator agent may edit `packages/contracts`; others ask it.

| Agent                                | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator / gateway                | `apps/server/src/helix/**` except `helix/rolePrompts*`; `persistence/**/Helix*` and new migrations 144+; `agentGateway/helixTools.ts`; the Helix block in `wsRpc.ts`; Helix lines in `serverLayers.ts`; every edit to `orchestration/Layers/ProviderCommandReactor.ts` (gate, session-start `helixRole` wiring, restart condition, branch/title guards); `agentGateway/Layers/AgentGateway.ts` (`assertCallerMayDriveThread`); `ThreadDeletionReactor.ts`, `threadRetention.ts`, decider guards; `packages/contracts`. |
| Provider adapters and harness policy | `helix/rolePrompts.ts` (+ test); `provider/Layers/ClaudeAdapter.ts`; `codexAppServerManager.ts` and the Codex adapter; `agentGateway/harnessPolicy.ts`; adapter tests. Does not edit PCR: the coordinator calls `renderHelixRoleInstructions`.                                                                                                                                                                                                                                                                         |
| Web                                  | `apps/web/**` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 12. Open questions (with the default to use)

1. Upstream migration collision. Synara upstream may also claim 143. Default: keep 143 in this
   fork; on an upstream merge, renumber only if 143 has not shipped in an Arbor release, otherwise
   add a `MIGRATION_LINEAGE_ALIASES` entry.
2. User messages typed into the Builder thread. Default: refuse while the pair is active
   (`HELIX_UNSUPPORTED_THREAD`); approvals and user-input answers in the Builder are allowed.
3. Archiving or deleting the Builder alone. Default: refuse; it follows its Lead.
4. Delegating while a result awaits review. Default: refuse (`helix_review_pending`); the Lead must
   review first and puts further changes in the review.
5. Hub and sub-agent threads as Leads. Default: refuse threads with `parentThreadId`, sidechats,
   Hub coordinators and Hub members (`HELIX_UNSUPPORTED_THREAD`).
6. Lead tools appear only from the Lead's next session start. Default: `enable` restarts the Lead's
   session at its next idle boundary (provider tool lists are cached; `toolRuntime.ts`).
7. Lost tool response. If `result.returned` committed but the MCP response never reached the Lead
   (turn torn down after the handler returned), the Lead never sees the result. Default: accept for
   the prototype; `helix_inspect` shows it, and the Lead's next turn can read it.
8. A completed Builder turn without `helix_report`. Default: deliver it with `source:
"final_message"` and outcome `partial`; do not re-prompt the Builder.
9. Dispatch counting. Default: an attempt counts when `dispatch.start` commits; a suppressed attempt
   is refunded; failed and uncertain ones are not.
10. Stop during `dispatching`. Default: the handoff becomes `interrupted` (not `uncertain`): the
    Builder is interrupted either way and nothing is resent.

## 13. Not verified in this stage

No coordinator, dispatch, wake, Stop interception or prompts exist yet, so nothing has run end to end
with a provider. The gateway mechanism is tested with the gateway harness and the real registry
derivation, not with a live Claude or Codex session.

## 14. Stage 2: what is implemented

- `helix/coordinator.ts` (`makeHelixCoordinator`) implements `HelixService`, `HelixGatewayPort` and
  the hooks `HelixCoordinatorService` (`roleOf`, `builderThreadIds`, `sessionRoleFor`,
  `admitAutomaticTurn`, `interceptClientCommand`, `onDomainEvent`, `sweep`, `reconcileStartup`).
  `helix/Layers/HelixCoordinator.ts` wires it to the engine through `helix/runtime.ts`, runs startup
  reconciliation while the layer is built, consumes domain events through a queue, and sweeps every
  2 s for output that settles after the Builder's last event. It is built before the provider
  command reactor and the gateway (`serverLayers.ts`).
- Message text: `helix/messages.ts` (brief, Lead wake). The wake carries the result in its own turn
  text, framed as untrusted Builder output; it does not use the gateway completion outbox.
- Each change holds a per-pair lock only for load, transition and commit; effects run after it.
  During restart reconciliation results are finalised but not delivered (`suppressDelivery`);
  the restart hold delivers them on Resume.
- Lead tools appear after `enable` at the Lead's next turn start: the reactor restarts a session
  whose Helix role key (`role:pairId:promptVersion`) changed.
- Auto-approval: Helix does not set `autoApproveSynaraTools`. Adapters call
  `shouldAutoApproveSynaraGatewayTool({ autoApproveSynaraTools, helixRole }, toolName)`
  (`agentGateway/computerToolPermission.ts`); it is role-exact since stage 3.
- Guards: Builder user turns, edits, archive, delete and workspace `thread.meta.update` fields are
  refused in `wsRpc.ts`; ordinary gateway thread tools refuse a Builder target
  (`assertCallerMayDriveThread`); the reactor skips branch and title generation for a Builder;
  quit-resume drops Builder threads; retention never archives a Builder alone.
- Lifecycle: `thread.archived` of the Lead stops the pair and archives the Builder;
  `thread.unarchived` unarchives it; `thread.deleted` of the Lead stops the pair, deletes the Builder,
  deletes the pair and publishes `pair-removed`.

## 15. Stage 3: integration test and review round

### Contract additions (`packages/contracts/src/helix.ts`, all optional)

```ts
export const HelixLateResultReason = Schema.Literals(["stop", "uncertain_send", "interrupted"]);
// HelixHandoff
lateResultReason: Schema.optional(HelixLateResultReason),
leadTurnId: Schema.optional(Schema.NullOr(TurnId)), // the Lead turn that created the handoff
// HelixPairSummary
latestHandoffState: Schema.optional(Schema.NullOr(HelixHandoffState)),
```

The repository stores both in the handoff's `record_json` (no migration); older rows decode
without them. Role text is `helix-roles/2` (provider agent).

### Behaviour changed in this round

- Restart: a `running` handoff stays `running` under a `restart` hold; its turn's real outcome
  settles it later and the result waits for Resume. `dispatching` with a started turn becomes
  `running` (`turn_started`). Nothing is resent.
- Report binding: `helix_report` from a turn other than the one the brief started is refused
  (`helix_no_running_handoff`); a matching report binds the turn through `dispatch.acknowledged`.
  A report filed before the turn is projected is stored unbound and used only if no other turn is
  bound at settlement.
- Refused Builder creation or brief → `dispatch.abandoned` → failed, delivered to the Lead.
- Effects run on a detached fiber joined by the caller, so an interrupted tool call cannot abandon
  half-run effects.
- Builder runtime mode is the strictest of the pair config, the Lead's current mode and the
  Builder's current mode, at creation and at every brief. It can be lowered but not raised again
  without reconfiguring.
- Before each brief the Builder's workspace fields are synced from the Lead's when they differ
  (`helix:sync-workspace:<dispatchCommandId>`).
- `updateConfig` applies the Builder model through `thread.meta.update` synchronously; a failure is
  returned to the caller. Each brief also carries `modelSelection`.
- Plan mode: `helix_delegate` and `helix_review` with `changes_requested` are refused when the Lead is
  in plan mode; `accepted` and `blocked` are allowed.
- Guards (client commands, `interceptClientCommand`): Builder `turn.start`/`edit-and-resend`
  (active pair), archive, delete, workspace or model `thread.meta.update`; Lead workspace
  `thread.meta.update` and unsupported-provider model switches while active; `checkpoint.revert` on
  either side while a handoff is in flight or the other participant is busy (fails closed); a hand
  off of an active participant (`thread.handoff.create`, `gitHandoffThread` via
  `assertMayMoveWorkspace`). Gateway: every ordinary thread tool that targets a Builder is refused
  (send, interrupt, title, pull request, archive, goal), including from its own Lead.
- Undecodable pair rows are quarantined at startup instead of failing the layer: their Builders keep
  `helix_builder`, their Leads lose the Lead role, and no server turn runs on either.
- `enable` is refused (`HELIX_UNAVAILABLE`) when the credentials service cannot set role profiles.
- Session roles on provider-initiated restarts: `ProviderHelixRoleResolverLive` is one shared
  instance (provider layer and Helix layer in `serverLayers.ts`); the coordinator registers
  `hooks.sessionRoleFor` at start. ProviderService asks it on session recovery, credential rotation
  and provider-switch restore. `sessionRoleFor` answers from memory only: `null` for a thread not in
  an active pair (or a Lead when the setting is off or its pair is quarantined), a Builder always keeps
  its Builder role while its pair is active. It cannot fail, so "could not determine" does not arise;
  with no registered lookup, ProviderService keeps the persisted role.
- Sub-agent context: the gateway cannot tell a native sub-agent's call from its parent's (same MCP
  credential). The provider agent denies `helix_*` from Claude sub-agents (`agentID`) and turns off
  Codex `multi_agent` for Leads; Builders cannot spawn sub-agents (`Agent`, `Task`, `Workflow`,
  `EnterWorktree` disallowed).

### Tests

- `helix/helix.integration.test.ts`: the real composition (`makeWsRpcLayer` with admission, engine,
  reactor, gateway with real credentials and MCP transport, Helix layer, file SQLite, the server's
  startup pipeline); only the Codex and Claude adapters are scripted. Covers enable → role restart →
  four Lead tools; delegate → Builder in the Lead's worktree with no setup rerun; report → in-tool
  result; timeout → one wake; changes_requested on the same Builder session → accepted; Stop on
  Lead and on Builder with a server-queued turn (never sent), late result stored, stop hold in
  `helix.subscribe`, user message releases; restart mid-handoff (held, running, nothing resent,
  roles applied before MCP); Builder user message refused and approvals round-trip; recovery after
  disable starts with no role (through the shared resolver); Helix off: enable refused and an
  ordinary thread's trace equal to Helix on.
- Coordinator: gate for every server-turn kind on a Builder and a stopped Lead, revert guard, plan
  mode, strictest runtime mode and workspace sync, `wake_requested` at a crash (unsent and sent),
  quarantine of an undecodable pair, enable refused without role profiles, Lead workspace and
  provider guards, a refused Builder model change surfaced, plus the reviewer probes P1–P7
  (`coordinator.review.test.ts`).
- Reactor: a held Helix turn reaches no provider call; the pre-send check stops a server turn on a
  participant admitted earlier.
- Gateway: tool lists of every non-Helix harness credential equal the pre-Helix capture
  (`agentGateway/Layers/__fixtures__/toolListsBeforeHelix.json`); role-exact auto-approval;
  registry without a profile unchanged.

### Not verified

- No live Claude or Codex process: adapters are scripted, so provider-side role text delivery,
  sub-agent denial and Codex `multi_agent` are covered only by the provider agent's unit tests.
- A real server crash (provider processes dying with the server) is approximated by closing the
  runtime scope over the same database.
- The web client.

## 16. Stage 3, second review round

### Contract additions (all additive)

`packages/contracts/src/helix.ts`:

```ts
export const HelixRefusalReason = Schema.Literals([
  "pair_active", "builder_read_only", "builder_follows_lead", "builder_workspace_fixed",
  "builder_model_in_settings", "lead_workspace_locked", "lead_provider_unsupported",
  "revert_builder_busy", "revert_lead_busy", "revert_unknown", "workspace_in_pair",
]);
export const HelixQuarantinedPair = Schema.Struct({
  pairId: Schema.String, leadThreadId: Schema.String, builderThreadId: Schema.String,
  reason: Schema.String,
});
// HelixListPairsResult and the subscribe "snapshot" event
quarantined: Schema.optional(Schema.Array(HelixQuarantinedPair)),
// HelixTurnIntent (frozen so a resend is the identical command)
runtimeMode: Schema.optional(RuntimeMode),
interactionMode: Schema.optional(ProviderInteractionMode),
// New RPC helix.removePair (owner only)
export const HelixRemovePairInput = Schema.Struct({ pairId: Schema.String });
export const HelixRemovePairResult = Schema.Struct({ pairId: Schema.String, removed: Schema.Boolean });
```

`packages/contracts/src/rpc.ts`: `WsRpcError.reason: Schema.optional(Schema.String)`. Participant
refusals keep `code: HELIX_UNSUPPORTED_THREAD` and add `reason` (a `HelixRefusalReason`).
`packages/contracts/src/helixRpc.ts`: `WsHelixRemovePairRpc` in `WsHelixRpcGroup`.
`packages/contracts/src/ipc.ts`: optional `NativeApi.helix.removePair`.

### Rules

- Delivery. A review closes any unfinished delivery of that handoff (`pending`, `wake_requested`,
  `wake_dispatched` → `acknowledged`). `wake.request` on a reviewed handoff closes it and never arms
  a wake; `wake.suppressed` on a reviewed handoff closes it. A suppressed wake returns to `pending`
  only under a hold or with the setting off, and neither lets the sweep re-deliver.
- Bounds. Every sweep-driven retry has a cap or a terminal state: at most
  `HELIX_MAX_WAKE_ATTEMPTS` (5) automatic wakes per handoff, then the pair is held `uncertain`
  ("could not wake the Lead…"); a frozen brief or wake without an engine receipt is resent at most
  5 times, then the brief is `uncertain` and the wake returns to `pending` (counting toward the wake
  cap); prepared work is dispatched only while unheld with the setting on.
- Visible messages. A refused queued wake or brief can leave its one message in the chat: the
  engine appends a `thread.turn.start` message when the command is accepted, before the reactor's
  gate. After the delivery rules above this happens only in a race (Stop or review while the turn is
  queued) and never repeats. Removing it needs a decider change; not done.
- Stop. If the Stop cannot commit, Helix still sends turnless interrupts to both participants and
  fences the pair in memory: every Helix turn of a fenced pair is refused (fail closed) until a
  durable stop commits. The sweep retries the stop; a user message to the Lead commits the stop
  before starting its goal.
- Quarantine. A pair row or any handoff row that does not decode quarantines the pair, at boot or at
  runtime. The aggregate loads with the readable handoffs so a Stop still commits; every other
  mutation is refused. `listPairs` and the subscribe snapshot list readable pairs and the quarantined
  ones separately (`quarantined`); `getPair` returns null for a quarantined Lead. Ways out:
  `helix.removePair` (deletes the rows by id without decoding, archives the Builder, clears every
  role and guard), deleting the Lead (also deletes the Builder) or deleting the Builder.
- Gate. Helix briefs run while current and the pair is active, unquarantined, unfenced, not stopped
  and in the current epoch. Pause, a limit, a restart hold and the setting turned off stop NEW work
  only: a brief already dispatched still starts and runs, and its result is held. Wakes need no hold
  and the setting on. A pre-send refusal of a Helix turn records the suppression and settles the
  session quietly (no session error, no failed handoff). Non-Helix turns on a Lead are ordinary
  (automations, goals, Hub, kanban run under a stop hold; `helix_delegate` is refused under any hold
  and a `changes_requested` correction stays prepared). A Builder runs only its briefs; any other
  turn aimed at it is refused with a visible "Turn refused by Helix" activity (or the goal or
  recovery failure it already had).
- Setting off. Behaves like Pause for running work. Lead role profiles follow the setting (the
  sweep re-applies them when it changes), so the Lead's credential loses the Helix tools; Lead
  guards apply only while its Builder is busy. Builders stay restricted regardless.
- Builder identity. A Builder is a Builder while its pair row exists: credential, session role and
  provider-side restrictions (session role is returned before the active check), never an ordinary
  chat. A disabled pair's Builder can be deleted (`builder.replaced` gives the pair a fresh Builder
  id, created lazily at the next dispatch). Deleting the Lead deletes both.
- Modes. Re-enable re-caps `builderRuntimeMode` to the Lead's current mode. Each brief's mode is
  computed once (strictest of config, Lead, Builder) and frozen in the intent.
- Engine errors. Only decider refusals (`Invariant`, `PreviouslyRejected`) are rejections. An
  identity collision is "already accepted" when the receipt is accepted, otherwise unknown;
  timeouts, admission and internal errors are unknown.
- Role text. Sessions always start with the current role text (`helix-roles/2`). Enable, re-enable
  and the sweep (idle pairs, including at server start) pin `config.rolePromptVersions` to it. A
  server restart ends every provider session, so no session keeps an older text; the reactor
  restarts a live session whose role key changes.
- `gitHandoffThread` is refused when its `cwd` is inside an active pair's workspace, as well as for
  a participant thread.

## 17. Stage 3, third review round

### Storage (append-only migrations; 143 unchanged since the foundation stage)

- `144_HelixRetiredBuilders`: `helix_retired_threads (thread_id PRIMARY KEY, pair_id, retired_at)`.
- `145_HelixStopRequests`: `helix_stop_requests (pair_id PRIMARY KEY, requested_at)`.
- Both `CREATE TABLE IF NOT EXISTS`. `145_HelixStopRequests.test.ts` migrates a database stopped at
  143 (and at the first 144) forward and boots the coordinator over it.

### Rules

- Retired Builders. A former Builder never loses its restriction and never becomes an ordinary
  chat. Removing a pair, deleting the Lead, or deleting a disabled pair's Builder retires the
  Builder thread: a `helix_retired_threads` row (written in the same transaction as the pair
  deletion, or before `builder.replaced`) and the gateway profile `helix_retired`, which grants no
  capability at all on every credential the thread holds or is issued later (no MCP connectors
  either). Boot re-applies it from the table. A retired thread runs no turn (the gate refuses it),
  takes no message, unarchive or workspace change (`reason: "builder_read_only"`), and can be
  archived or deleted. The Lead of a removed pair becomes an ordinary chat.
- `removePair` on a readable active pair commits a durable Stop first (epoch, hold, Builder
  interrupt), then deletes. It also clears the pair's lock and retry counters.
- Resume after the wake limit: an explicit Resume emits `deliver_result` with `afterResume`, and the
  next `wake.request` may go once past `HELIX_MAX_WAKE_ATTEMPTS`; if that wake fails too, the pair is
  held again.
- Under a stop hold `helix_review` with `changes_requested` is refused (`helix_pair_held`); accept
  and block are allowed. `helix_delegate` is refused under any hold. No other tool creates
  dispatchable work.
- Builder creation: an unknown engine outcome is retried by the sweep at most 5 times, then the
  handoff is abandoned (`failed`, delivered to the Lead). The creation command is frozen per attempt
  in memory, so a Lead rename between retries cannot cause an identity collision.
- Stop fence across restarts: a Stop that cannot commit records a `helix_stop_requests` row (best
  effort; it needs no decoding). Boot reloads fences from it; the sweep commits the stop and clears
  the row; a user message commits the stop before its goal. If storage is down entirely, the row
  cannot be written and the fence is in memory only: after such a restart the pair gets a `restart`
  hold that a user message releases, and a late result of the stopped turn is delivered rather than
  suppressed.
- `assertMayMoveWorkspace(threadId, cwd)` compares path segments (`/repo` does not cover `/repo-2`)
  and skips an active Lead whose projection cannot be read instead of blocking every git handoff.

## 18. Turning Helix on from the composer (the pairing rides on the message)

Modelled on the user's "Fusion": one composer control; the choice goes out with the next
message; the server applies it before that message's turn starts.

### Contract (additive)

`packages/contracts/src/orchestration.ts` (re-exported from `./helix`, which cannot be imported by
`orchestration.ts` without a cycle):

```ts
export const HelixMessagePairing = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(true), builderModelSelection: ModelSelection }),
  Schema.Struct({ enabled: Schema.Literal(false) }),
]);
export const HelixPairingNotAppliedReason = Schema.Literals([
  "setting_off", "unsupported_thread", "unsupported_lead_provider",
  "unsupported_builder_provider", "builder_thread", "quarantined", "unavailable",
]);
export const HelixPairingOutcome = Schema.Struct({
  status: Schema.Literals(["applied", "pending", "unchanged", "not_applied"]),
  reason: Schema.optional(HelixPairingNotAppliedReason),
  message: Schema.optional(Schema.String),
});
// ThreadTurnStartCommand, ClientThreadTurnStartCommand, ThreadMessageEditAndResendCommand:
helix: Schema.optional(HelixMessagePairing),
// DispatchResult:
helixPairing: Schema.optional(HelixPairingOutcome),
```

`packages/contracts/src/helix.ts`: `WS_HELIX_MESSAGE_PAIRING_CAPABILITY = "helix.message-pairing"`
(advertised in `WS_SERVER_CAPABILITIES`); `HelixPendingChange = Union([{ kind: "builder",
builderModelSelection }, { kind: "disable" }])`; `HelixPairConfig.pendingChange` and
`HelixPairSummary.pendingChange`, `latestHandoffFailure`, `latestHandoffUpdatedAt` (all
optional).

### Behaviour

- The web's first message in a new chat is `thread.create` (then, for a worktree,
  `thread.meta.update` to the worktree it made), then `thread.turn.start`; queued and steered
  messages are `thread.turn.start` with `dispatchMode`. The pairing rides on `thread.turn.start`
  (and `thread.message.edit-and-resend`).
- `interceptClientCommand` plans the pairing (no change), registers a per-message latch, and
  returns the outcome, which `wsRpc` adds to `DispatchResult.helixPairing`. If the engine refuses
  the message, the latch is released and nothing is applied. Once accepted, `afterAccepted`
  applies it, releases the latch, then starts the goal. The reactor's
  `processTurnStartRequestedWithoutLease` first awaits that message's latch (at most 15 s), so the
  turn's session start reads the new role: a new chat's first session already carries the Lead
  role and tools, with no restart.
- Plans: off with no pair → `unchanged`; on with no pair or a disabled pair → enable or
  re-enable; on with a different Builder → `config.update` when idle, else `pending`; same
  Builder with a pending change → the pending change is cleared; off on an active pair → disable
  when idle, else `pending`. Busy means a handoff in flight or awaiting review.
- Pending changes are kept in `config.pendingChange` (new state-machine command
  `config.pending`) and applied when the pair is idle: by the sweep, after an accepted or blocked
  review, and before a new delegation. A correction keeps the current Builder. A Builder change
  through `config.update`, disable and enable clear it.
- Ineligible threads (setting off, Builder or retired Builder, quarantined pair, sub-agent, side
  chat, Hub, unsupported Lead or Builder provider) get `not_applied` with a reason; the message
  is sent as an ordinary message.
- Exactly once: applied pairings are remembered per message id (in memory), and `user_message`
  ignores a message id that already started the current goal, so a retried command changes
  nothing. Not durable across a server restart (a retry after a restart replays the same pairing,
  which is idempotent unless a later message changed the pair).
- A pair enabled with the first message is created after the web has moved the chat to its
  worktree; the Builder is created lazily at the first delegation from the Lead's current
  workspace, so it lands in the final worktree and branch.
- Banner: `HelixPairSummary` gives `builderThreadId`, `status`, `hold` (with reason),
  `latestHandoffState` (`awaiting_review` = "finished · lead is reviewing"),
  `latestHandoffFailure`, `latestHandoffUpdatedAt` and `pendingChange`. The Builder's current
  step, command duration and pending approvals come from the Builder thread's own shell and
  activities, as Fusion did.

## 19. Message pairing: review fixes

- Authority. A pairing on a message has exactly the authority of the `helix.*` RPCs: `wsRpc`
  passes `mayConfigureHelix: CurrentWsSessionRole === "owner"` to `interceptClientCommand`. For
  any other session (a paired client, a remote device) the message is still sent, nothing about
  the pair changes, and the outcome is `not_applied` with the new reason `"not_permitted"`.
- No latch. The intercept only records the planned pairing. Whichever comes first applies it:
  the RPC's `afterAccepted`, or the reactor's `awaitMessagePairing` when it reaches the message's
  turn. A second caller waits for the first (an in-memory promise per message). A message
  without a planned pairing takes no wait. The apply is uninterruptible.
- Exit handling. `afterAccepted` runs in the dispatch's exit handler on success, so a disconnect
  right after acceptance cannot skip the pairing or the goal start. On a definite refusal the
  plan is dropped. On an interruption it is kept: if the engine did accept the message, the
  reactor applies it at the turn. A plan for a message never accepted stays in memory unused.
  The reactor's call is bounded (15 s) and runs before the session is ensured, so it holds no
  provider session. It is a database write or two, not a wait on another fiber.
- Exactly once, durably. Migration `146_HelixAppliedMessages` adds `helix_applied_messages
(message_id, effect, applied_at)`. A message's pairing and its goal start are each claimed there
  before they run (`INSERT … ON CONFLICT DO NOTHING RETURNING`). A retried command, also after a
  restart, claims nothing, and the intercept reports such a message as `unchanged`.
- Truthful outcome. A failed enable, or a failed disable or update whose fallback pending change
  also fails, adds a `helix.pairing.failed` activity ("Helix change not applied") to the Lead's
  chat. A Builder change through `config.update` clears only a pending Builder change, never a
  pending off.
- The retired-Builder list is read with three retries at boot. If it still fails, the sweep
  retries every 2 s; until then a retired Builder's id is not restricted. The same database
  holds the provider session bindings, so sessions cannot start either while it is unreadable.
