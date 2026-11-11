import type {
  JiraConnectInput,
  JiraIssueDetail,
  JiraIssueInput,
  JiraIssuesInput,
  JiraIssuesResult,
  JiraStatus,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/** Stable codes a client can branch on. The message is always fit to show as it is. */
export type JiraErrorCode =
  | "JIRA_NOT_CONNECTED"
  | "JIRA_INVALID_INPUT"
  | "JIRA_AUTH"
  | "JIRA_FORBIDDEN"
  | "JIRA_NOT_FOUND"
  | "JIRA_RATE_LIMITED"
  | "JIRA_UNAVAILABLE";

/**
 * Every Jira failure a caller sees. The message is fixed text chosen here, never Jira's response
 * body or a process error, so it cannot carry the API token or another site's content.
 */
export class JiraError extends Error {
  override readonly name = "JiraError";
  readonly code: JiraErrorCode;
  constructor(code: JiraErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface JiraServiceShape {
  /** Never fails: a connection that no longer works is reported as not connected, with why. */
  readonly status: () => Effect.Effect<JiraStatus>;
  /** Checks the credentials against Jira before saving them; a failed check saves nothing. */
  readonly connect: (input: JiraConnectInput) => Effect.Effect<JiraStatus, JiraError>;
  readonly disconnect: () => Effect.Effect<JiraStatus, JiraError>;
  readonly issues: (input: JiraIssuesInput) => Effect.Effect<JiraIssuesResult, JiraError>;
  readonly issue: (input: JiraIssueInput) => Effect.Effect<JiraIssueDetail, JiraError>;
}

export class JiraService extends ServiceMap.Service<JiraService, JiraServiceShape>()(
  "synara/jira/Services/JiraService",
) {}
