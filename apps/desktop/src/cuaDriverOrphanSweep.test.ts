// FILE: cuaDriverOrphanSweep.test.ts
// Purpose: Verifies the asynchronous orphaned cua-driver sweep reaps only daemons whose host died.
// Layer: Desktop computer-use host tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const sweepDirectoriesMock = vi.hoisted(() =>
  vi.fn((_options: { readonly liveSocketDirs: ReadonlySet<string> }): string[] => []),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("./cuaRuntimeOwnership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cuaRuntimeOwnership")>()),
  sweepOwnedCuaRuntimeDirectories: sweepDirectoriesMock,
}));

import { sweepOrphanedCuaDrivers } from "./cuaDriverHost";

const DEAD_HOST_PID = 2_147_000_001;
const LIVE_HOST_PID = 2_147_000_002;
const ORPHAN_PID = 2_147_000_101;
const LIVE_DAEMON_PID = 2_147_000_102;

type ExecFileCallback = (error: Error | null, stdout: string) => void;

function answerPs(outputs: (args: readonly string[]) => string | Error): void {
  execFileMock.mockImplementation(
    (_command: string, args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
      // Answer asynchronously, as the real child process does.
      setImmediate(() => {
        const output = outputs(args);
        if (output instanceof Error) callback(output, "");
        else callback(null, output);
      });
    },
  );
}

describe.skipIf(process.platform === "win32")("sweepOrphanedCuaDrivers", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockReset();
    sweepDirectoriesMock.mockClear();
    killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === DEAD_HOST_PID) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("kills only daemons whose recorded host is gone and protects every live socket dir", async () => {
    answerPs((args) => {
      if (args[0] === "-axo") {
        return [
          "  PID ARGS",
          `${ORPHAN_PID} /x/cua-driver serve --embedded --socket /tmp/synara-cua-aaaaaa/driver-1.sock`,
          `${LIVE_DAEMON_PID} /x/cua-driver serve --embedded --socket /tmp/synara-cua-bbbbbb/driver-2.sock`,
          `${process.pid} /x/cua-driver serve --embedded --socket /tmp/synara-cua-cccccc/driver-3.sock`,
          "123 /usr/bin/unrelated",
        ].join("\n");
      }
      const pid = Number(args[2]);
      if (pid === ORPHAN_PID)
        return `COMMAND\n/x/cua-driver CUA_DRIVER_EMBEDDED_HOST_PID=${DEAD_HOST_PID}`;
      if (pid === LIVE_DAEMON_PID)
        return `COMMAND\n/x/cua-driver CUA_DRIVER_EMBEDDED_HOST_PID=${LIVE_HOST_PID}`;
      return new Error(`unexpected ps for ${pid}`);
    });

    const sweep = sweepOrphanedCuaDrivers();
    // The scan runs off the main thread: nothing is killed before ps answers.
    expect(killSpy).not.toHaveBeenCalledWith(ORPHAN_PID, "SIGKILL");
    await sweep;

    expect(killSpy).toHaveBeenCalledWith(ORPHAN_PID, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(LIVE_DAEMON_PID, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGKILL");
    expect(sweepDirectoriesMock).toHaveBeenCalledTimes(1);
    expect([...sweepDirectoriesMock.mock.calls[0]![0].liveSocketDirs].toSorted()).toEqual([
      "/tmp/synara-cua-aaaaaa",
      "/tmp/synara-cua-bbbbbb",
    ]);
  });

  it("keeps a daemon whose environment cannot be read, and its socket dir", async () => {
    answerPs((args) =>
      args[0] === "-axo"
        ? `${ORPHAN_PID} /x/cua-driver serve --embedded --socket /tmp/synara-cua-aaaaaa/driver-1.sock`
        : new Error("ps failed"),
    );

    await sweepOrphanedCuaDrivers();

    expect(killSpy).not.toHaveBeenCalledWith(ORPHAN_PID, "SIGKILL");
    expect([...sweepDirectoriesMock.mock.calls[0]![0].liveSocketDirs]).toEqual([
      "/tmp/synara-cua-aaaaaa",
    ]);
  });

  it("resolves without reaping anything when the process listing fails", async () => {
    answerPs(() => new Error("ps unavailable"));

    await expect(sweepOrphanedCuaDrivers()).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
    expect(sweepDirectoriesMock).not.toHaveBeenCalled();
  });
});
