// Electron 43 bundles Undici 7.29, whose HTTP/1 writer can throw outside the
// fetch promise when macOS rejects setTypeOfService. Use the maintained
// dispatcher (including its Node-fetch compatibility adapter) before any
// desktop requests. Keep Node's fetch/Headers/Response globals and error policy.
// Upstream fix: https://github.com/nodejs/undici/pull/5547
//
// Loading undici takes about 20 ms, and nothing in this process sends a request
// before the backend child is spawned, so it loads on the first global fetch
// instead of before `app ready`. Every global fetch passes through the wrapper
// below, so no request can reach Electron's bundled dispatcher first.
import { createRequire } from "node:module";
import type * as Undici from "undici";

function installMaintainedDispatcher(): void {
  // The bundled main process is CommonJS and keeps undici external; the
  // plain-Node test imports this file as ESM, where only createRequire exists.
  const load = typeof require === "function" ? require : createRequire(import.meta.url);
  const { Agent, setGlobalDispatcher } = load("undici") as typeof Undici;
  setGlobalDispatcher(new Agent());
}

const nodeFetch = globalThis.fetch;
let dispatcherInstalled = false;

globalThis.fetch = function fetch(input, init) {
  if (!dispatcherInstalled) {
    try {
      installMaintainedDispatcher();
    } catch (error) {
      // Never send a request without the maintained dispatcher; the next
      // request retries the install.
      return Promise.reject(error);
    }
    dispatcherInstalled = true;
  }
  return nodeFetch(input, init);
} as typeof fetch;
