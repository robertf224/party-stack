import "fake-indexeddb/auto";
import { runManagedCacheRaces } from "./contracts/managedCacheRaces.js";
runManagedCacheRaces("managed cache races / IndexedDB");
