import { indexedDBManagedCacheHarness } from "./contracts/indexedDBManagedCacheHarness.js";
import { runManagedCacheContract } from "./contracts/managedCacheContract.js";
runManagedCacheContract("managed cache / native IndexedDB", indexedDBManagedCacheHarness);
