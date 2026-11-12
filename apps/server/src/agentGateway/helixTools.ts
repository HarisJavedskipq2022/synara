/**
 * The Helix tool family: `helix_delegate`, `helix_wait`, `helix_inspect` and
 * `helix_review` for a Lead (capability `helix:lead`), `helix_report` for a
 * Builder (capability `helix:builder`, the only one a Builder credential
 * carries). Handlers decode untrusted arguments against the contract schemas
 * and forward to the {@link HelixGatewayPortShape}; they never take a role,
 * thread or pair from arguments.
 *
 * @module agentGateway/helixTools
 */
import {
  HELIX_BUILDER_GATEWAY_CAPABILITY,
  HELIX_DEFAULT_WAIT_SECONDS,
  HELIX_LEAD_GATEWAY_CAPABILITY,
  HELIX_MAX_WAIT_SECONDS,
  HELIX_REQUEST_ID_MAX_LENGTH,
  HelixDelegateToolInput,
  HelixInspectToolInput,
  HelixReportToolInput,
  HelixReviewToolInput,
  HelixWaitToolInput,
  ThreadId,
  TurnId,
  type HelixRole,
} from "@synara/contracts";
import { Effect, Schema, SchemaIssue } from "effect";

import {
  helixToolError,
  type HelixGatewayPortShape,
  type HelixToolCaller,
} from "../helix/Services/HelixGatewayPort.ts";
import { mcpToolResultJson } from "./protocol.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const text = (maxLength: number, description: string) =>
  ({ type: "string", maxLength, description }) as const;

const waitSecondsProperty = {
  type: "integer",
  minimum: 0,
  maximum: HELIX_MAX_WAIT_SECONDS,
  description: `Seconds to wait for the result (default ${HELIX_DEFAULT_WAIT_SECONDS}). On timeout the Builder keeps working and the result is delivered to you later as a new message; do not poll.`,
} as const;

const requestIdProperty = {
  type: "string",
  minLength: 1,
  maxLength: HELIX_REQUEST_ID_MAX_LENGTH,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  description:
    "Stable id for this request. Retrying with the same id and identical content returns the original; the same id with different content is refused.",
} as const;

const handoffIdProperty = { type: "string", minLength: 1, maxLength: 96 } as const;

export const HELIX_BRIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "acceptanceCriteria"],
  properties: {
    title: text(200, "Short name for this piece of work."),
    objective: text(8_000, "What the Builder must achieve."),
    context: text(
      16_000,
      "Decisions already made and findings to reuse, so the Builder does not rediscover them.",
    ),
    scope: text(8_000, "Files, modules or areas in scope, and what is out of scope."),
    constraints: text(8_000, "Rules the implementation must follow."),
    acceptanceCriteria: text(8_000, "How you will judge the result."),
    verification: text(8_000, "Checks the Builder must run and report."),
    runtimeNotes: text(
      4_000,
      "Dev servers, background processes or other runtime state to know about.",
    ),
  },
} as const;

export const HELIX_REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary"],
  properties: {
    outcome: { type: "string", enum: ["completed", "partial", "blocked", "failed"] },
    summary: text(8_000, "What you did and the result."),
    changes: text(8_000, "Files and areas changed."),
    verification: text(8_000, "Checks you ran and their results, with exact commands."),
    deviations: text(4_000, "Where you departed from the brief, and why."),
    blockers: text(4_000, "What stopped you, if anything."),
    followUps: text(4_000, "Work you recommend next."),
  },
} as const;

function decodeArgs<S extends Schema.Top>(
  schema: S,
  args: Record<string, unknown>,
): Effect.Effect<S["Type"], GatewayToolError> {
  return Schema.decodeUnknownEffect(schema as never)(args).pipe(
    Effect.mapError((error: unknown) =>
      helixToolError(
        "helix_invalid_input",
        `Invalid arguments: ${
          Schema.isSchemaError(error)
            ? SchemaIssue.makeFormatterDefault()(error.issue)
            : String(error)
        }`,
      ),
    ),
  ) as Effect.Effect<S["Type"], GatewayToolError>;
}

function callerFor(context: ToolContext, role: HelixRole): HelixToolCaller {
  return {
    threadId: ThreadId.makeUnsafe(context.callerThreadId),
    turnId: context.callerTurnId === null ? null : TurnId.makeUnsafe(context.callerTurnId),
    sessionKey: context.callerSessionKey,
    provider: context.callerProvider,
    role,
  };
}

function runHelixTool<A>(
  context: ToolContext,
  role: HelixRole,
  run: (caller: HelixToolCaller) => Effect.Effect<A, GatewayToolError>,
) {
  const capability =
    role === "lead" ? HELIX_LEAD_GATEWAY_CAPABILITY : HELIX_BUILDER_GATEWAY_CAPABILITY;
  // The transport already filtered by capability; this is the second line.
  const guarded: Effect.Effect<A, GatewayToolError> = context.callerCapabilities.has(capability)
    ? run(callerFor(context, role))
    : Effect.fail(helixToolError("helix_no_pair", "This conversation is not a Helix participant."));
  return guarded.pipe(
    Effect.map(mcpToolResultJson),
    Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(error))),
  );
}

export function makeAgentGatewayHelixTools(input: {
  readonly port: HelixGatewayPortShape;
}): ReadonlyArray<ToolEntry> {
  const { port } = input;
  return [
    {
      definition: {
        name: "helix_delegate",
        description:
          "Delegate one scoped piece of implementation work to your Builder, which works in this chat's worktree with its own session. Write a complete brief: the Builder sees only the brief, not this conversation. Waits for the result; on timeout returns the handoff id and the Builder keeps working. Refused while another handoff is running or awaiting your review.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "brief"],
          properties: {
            requestId: requestIdProperty,
            brief: HELIX_BRIEF_JSON_SCHEMA,
            waitSeconds: waitSecondsProperty,
          },
        },
        annotations: { title: "Delegate to Builder", ...WRITE_TOOL_ANNOTATIONS },
      },
      requiredCapability: HELIX_LEAD_GATEWAY_CAPABILITY,
      requiresActiveTurn: true,
      handler: (args, context) =>
        runHelixTool(context, "lead", (caller) =>
          decodeArgs(HelixDelegateToolInput, args).pipe(
            Effect.flatMap((decoded) => port.delegate(caller, decoded)),
          ),
        ),
    },
    {
      definition: {
        name: "helix_wait",
        description:
          "Wait for your Builder's current (or a named) handoff to finish and return its result. Use only when you have nothing else to do; a result that arrives later is delivered to you as a new message.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { handoffId: handoffIdProperty, waitSeconds: waitSecondsProperty },
        },
        annotations: { title: "Wait for Builder", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      requiredCapability: HELIX_LEAD_GATEWAY_CAPABILITY,
      requiresActiveTurn: true,
      handler: (args, context) =>
        runHelixTool(context, "lead", (caller) =>
          decodeArgs(HelixWaitToolInput, args).pipe(
            Effect.flatMap((decoded) => port.wait(caller, decoded)),
          ),
        ),
    },
    {
      definition: {
        name: "helix_inspect",
        description:
          "Read the Helix pair's status, limits and recent handoffs, and one handoff in full (brief, report draft, result, review). Never waits and never changes anything.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            handoffId: handoffIdProperty,
            recent: { type: "integer", minimum: 0, maximum: 20 },
          },
        },
        annotations: { title: "Inspect Helix", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      requiredCapability: HELIX_LEAD_GATEWAY_CAPABILITY,
      handler: (args, context) =>
        runHelixTool(context, "lead", (caller) =>
          decodeArgs(HelixInspectToolInput, args).pipe(
            Effect.flatMap((decoded) => port.inspect(caller, decoded)),
          ),
        ),
    },
    {
      definition: {
        name: "helix_review",
        description:
          "Record your verdict on a Builder result: accepted, changes_requested (consolidated feedback becomes the Builder's next handoff in the same session) or blocked (escalate to the user). Accepting is your judgement only; it is not a human code review.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["handoffId", "requestId", "verdict"],
          properties: {
            handoffId: handoffIdProperty,
            requestId: requestIdProperty,
            verdict: { type: "string", enum: ["accepted", "changes_requested", "blocked"] },
            feedback: text(
              16_000,
              "Required for changes_requested and blocked: one consolidated list of everything that must change or that blocks the work.",
            ),
            expectedResultRevision: {
              type: "integer",
              minimum: 1,
              description: "The result revision you reviewed; the review is refused if it changed.",
            },
            waitSeconds: waitSecondsProperty,
          },
        },
        annotations: { title: "Review Builder result", ...WRITE_TOOL_ANNOTATIONS },
      },
      requiredCapability: HELIX_LEAD_GATEWAY_CAPABILITY,
      requiresActiveTurn: true,
      handler: (args, context) =>
        runHelixTool(context, "lead", (caller) =>
          decodeArgs(HelixReviewToolInput, args).pipe(
            Effect.flatMap((decoded) => port.review(caller, decoded)),
          ),
        ),
    },
    {
      definition: {
        name: "helix_report",
        description:
          "Report the outcome of your current handoff to the Lead. Call it once you have finished and verified the work (again to correct it), then end your turn. The report is delivered only after your turn ends.",
        inputSchema: HELIX_REPORT_JSON_SCHEMA,
        annotations: { title: "Report to Lead", ...WRITE_TOOL_ANNOTATIONS },
      },
      requiredCapability: HELIX_BUILDER_GATEWAY_CAPABILITY,
      requiresActiveTurn: true,
      handler: (args, context) =>
        runHelixTool(context, "builder", (caller) =>
          decodeArgs(HelixReportToolInput, args).pipe(
            Effect.flatMap((decoded) => port.report(caller, decoded)),
          ),
        ),
    },
  ];
}
