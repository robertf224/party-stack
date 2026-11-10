// Private fault-injection seam. Not exported from the package.
export * from "./engine.js";
export { makeReplicaKernel as makeReplica } from "./engine.js";
export { makeCachedProxy } from "./proxy.js";
export { connectReplicaParent, replicaStateSource } from "./parent.js";
