import { describe, expect, it } from "vitest";
import { getAtPath, setAtPath, unsetAtPath } from "./paths.js";

describe("property paths", () => {
    it("gets nested values and returns undefined for missing paths", () => {
        const value = { profile: { name: "Ada" } };

        expect(getAtPath(value, ["profile", "name"])).toBe("Ada");
        expect(getAtPath(value, ["profile", "missing"])).toBe(undefined);
    });

    it("sets paths without mutating the source", () => {
        const value = { profile: { name: "Ada" } };
        const updated = setAtPath(value, ["profile", "name"], "Grace");

        expect(updated).toEqual({
            profile: { name: "Grace" },
        });
        expect(value).toEqual({ profile: { name: "Ada" } });
        expect(updated.profile).not.toBe(value.profile);
    });

    it("creates missing structs but does not infer lists", () => {
        expect(setAtPath({}, ["profile", "name"], "Ada")).toEqual({
            profile: { name: "Ada" },
        });
        expect(() => setAtPath({ profiles: [] }, ["profiles", "0"], "Ada")).toThrow(
            'Cannot assign property path "profiles.0": "profiles" is not a struct object.'
        );
    });

    it("unsets paths without mutating the source", () => {
        const value = {
            profile: { name: "Ada", role: "admin" },
        };
        const updated = unsetAtPath(value, ["profile", "role"]);

        expect(updated).toEqual({ profile: { name: "Ada" } });
        expect(value.profile.role).toBe("admin");
    });
});
