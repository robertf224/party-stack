import { Icon } from "@blueprintjs/core";
import { describe, expect, it } from "vitest";
import { BlueprintIcon } from "./react.js";

describe("BlueprintIcon", () => {
    it("delegates mapped names and props to the Blueprint Icon component", () => {
        const element = BlueprintIcon({ name: "add", size: 20, title: "Add" });

        expect(element.type).toBe(Icon);
        expect(element.props).toMatchObject({
            icon: "plus",
            size: 20,
            title: "Add",
        });
    });

    it("passes unsupported mappings to Blueprint as empty icons", () => {
        const element = BlueprintIcon({ name: "ticket" });

        expect(element).toMatchObject({
            type: Icon,
            props: { icon: undefined },
        });
    });
});
