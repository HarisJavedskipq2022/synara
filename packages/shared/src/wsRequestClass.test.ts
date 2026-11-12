import { HELIX_WS_METHODS, ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyWsRequest,
  makeWsRequestCapacityError,
  WS_REQUEST_CLASS_LIMITS,
} from "./wsRequestClass";

describe("wsRequestClass", () => {
  it("keeps the per-connection budgets the server and client both enforce", () => {
    expect(WS_REQUEST_CLASS_LIMITS).toEqual({ control: 16, standard: 12, "expensive-read": 2 });
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe("control");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.replayEvents)).toBe("expensive-read");
    expect(classifyWsRequest(WS_METHODS.gitListBranches)).toBe("standard");
  });

  it("never queues a Helix pair control behind ordinary requests", () => {
    for (const method of [HELIX_WS_METHODS.stop, HELIX_WS_METHODS.pause, HELIX_WS_METHODS.resume]) {
      expect(classifyWsRequest(method)).toBe("control");
    }
    expect(classifyWsRequest(HELIX_WS_METHODS.getPair)).toBe("standard");
  });

  it("builds the retryable capacity rejection clients depend on", () => {
    expect(makeWsRequestCapacityError("expensive-read")).toMatchObject({
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
    });
    for (const requestClass of ["standard", "control"] as const) {
      expect(makeWsRequestCapacityError(requestClass)).toMatchObject({
        code: "RPC_REQUEST_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
        message: `WebSocket ${requestClass} request capacity exceeded.`,
      });
    }
  });
});
