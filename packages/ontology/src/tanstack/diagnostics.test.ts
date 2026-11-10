import { expect, test } from "vite-plus/test";
import { getCollectionDemands, registerCollectionDemands } from "./diagnostics.js";

test("demand inspection is read-only and old cleanup cannot remove a restarted sync reader", () => {
    const collection = {};
    expect(getCollectionDemands(collection)).toEqual([]);
    const old = registerCollectionDemands(collection, () => [{ objectType: "Old" }]);
    const latest = registerCollectionDemands(collection, () => [{ objectType: "Current" }]);
    old();
    expect(getCollectionDemands(collection)).toEqual([{ objectType: "Current" }]);
    latest();
    expect(getCollectionDemands(collection)).toEqual([]);
});
