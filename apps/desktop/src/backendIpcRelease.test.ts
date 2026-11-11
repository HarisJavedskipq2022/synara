// FILE: backendIpcRelease.test.ts
// Purpose: Verifies a backend whose work is done exits once the desktop closes its IPC channel.
// Layer: Desktop backend shutdown tests

import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { releaseBackendIpcChannel } from "./backendShutdown";

describe("releaseBackendIpcChannel", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets a child that only listens for IPC messages exit normally", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synara-backend-ipc-"));
    directories.push(directory);
    const script = join(directory, "backend.cjs");
    // Like the backend once its runtime has shut down: nothing is left but the
    // update bridge's message listener on the parent channel.
    writeFileSync(script, 'process.on("message", () => {});\nprocess.send("ready");\n');
    const child = fork(script, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      await new Promise<void>((resolve) => child.once("message", () => resolve()));
      // The listener alone keeps the child running.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.exitCode).toBeNull();

      releaseBackendIpcChannel(child);

      await expect(exited).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("ignores a channel that is already closed", () => {
    let disconnects = 0;
    const closed = {
      connected: false,
      disconnect: () => {
        disconnects += 1;
      },
    };
    expect(() => releaseBackendIpcChannel(closed)).not.toThrow();
    expect(disconnects).toBe(0);

    const failing = {
      connected: true,
      disconnect: () => {
        throw new Error("channel closing");
      },
    };
    expect(() => releaseBackendIpcChannel(failing)).not.toThrow();
  });
});
