/**
 * helix.* RPC definitions, served as a satellite group (like the project-agent
 * group) so the main feature group's inferred type stays under the
 * declaration emit limit. The server merges it into its admitted group; a
 * client merges it only after the server advertises `helix.pairs`.
 *
 * @module helixRpc
 */
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  HELIX_WS_METHODS,
  HelixCapabilitiesInput,
  HelixCapabilitiesResult,
  HelixEnableInput,
  HelixGetPairInput,
  HelixGetPairResult,
  HelixListPairsInput,
  HelixListPairsResult,
  HelixRemovePairInput,
  HelixRemovePairResult,
  HelixPairControlInput,
  HelixPairView,
  HelixStopInput,
  HelixStreamEvent,
  HelixSubscribeInput,
  HelixUpdateConfigInput,
} from "./helix";
import { WsRpcError } from "./rpc";

export const WsHelixCapabilitiesRpc = Rpc.make(HELIX_WS_METHODS.capabilities, {
  payload: HelixCapabilitiesInput,
  success: HelixCapabilitiesResult,
  error: WsRpcError,
});
export const WsHelixListPairsRpc = Rpc.make(HELIX_WS_METHODS.listPairs, {
  payload: HelixListPairsInput,
  success: HelixListPairsResult,
  error: WsRpcError,
});
export const WsHelixGetPairRpc = Rpc.make(HELIX_WS_METHODS.getPair, {
  payload: HelixGetPairInput,
  success: HelixGetPairResult,
  error: WsRpcError,
});
export const WsHelixEnableRpc = Rpc.make(HELIX_WS_METHODS.enable, {
  payload: HelixEnableInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixDisableRpc = Rpc.make(HELIX_WS_METHODS.disable, {
  payload: HelixPairControlInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixUpdateConfigRpc = Rpc.make(HELIX_WS_METHODS.updateConfig, {
  payload: HelixUpdateConfigInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixPauseRpc = Rpc.make(HELIX_WS_METHODS.pause, {
  payload: HelixPairControlInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixResumeRpc = Rpc.make(HELIX_WS_METHODS.resume, {
  payload: HelixPairControlInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixStopRpc = Rpc.make(HELIX_WS_METHODS.stop, {
  payload: HelixStopInput,
  success: HelixPairView,
  error: WsRpcError,
});
export const WsHelixRemovePairRpc = Rpc.make(HELIX_WS_METHODS.removePair, {
  payload: HelixRemovePairInput,
  success: HelixRemovePairResult,
  error: WsRpcError,
});
export const WsHelixSubscribeRpc = Rpc.make(HELIX_WS_METHODS.subscribe, {
  payload: HelixSubscribeInput,
  success: HelixStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsHelixRpcGroup = RpcGroup.make(
  WsHelixCapabilitiesRpc,
  WsHelixListPairsRpc,
  WsHelixGetPairRpc,
  WsHelixEnableRpc,
  WsHelixDisableRpc,
  WsHelixUpdateConfigRpc,
  WsHelixPauseRpc,
  WsHelixResumeRpc,
  WsHelixStopRpc,
  WsHelixRemovePairRpc,
  WsHelixSubscribeRpc,
);
