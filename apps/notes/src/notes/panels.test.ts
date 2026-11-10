import { expect, test } from "vite-plus/test";
import { resizePanels } from "./panels";

test("dragging the note divider shrinks folders after reaching the note minimum, stopping at both minimum widths", () => {
    const start = { folders: 240, notes: 300 };
    expect(resizePanels(start, "notes", -50, 1400)).toEqual({ folders: 240, notes: 250 });
    expect(resizePanels(start, "notes", -150, 1400)).toEqual({ folders: 208, notes: 200 });
    expect(resizePanels(start, "notes", -340, 1400)).toEqual({ folders: 208, notes: 200 });
    expect(resizePanels(start, "notes", -500, 1400)).toEqual({ folders: 208, notes: 200 });
    expect(resizePanels(start, "notes", -800, 1400)).toEqual({ folders: 208, notes: 200 });
});
test("panes leave writing space and can be expanded from zero", () => {
    expect(resizePanels({ folders: 240, notes: 300 }, "notes", 500, 1200)).toEqual({
        folders: 240,
        notes: 640,
    });
    expect(resizePanels({ folders: 0, notes: 0 }, "notes", 250, 1200)).toEqual({ folders: 0, notes: 250 });
});

test("folder dragging never snaps the sidebar closed", () => {
    expect(resizePanels({ folders: 240, notes: 300 }, "folders", -100, 1400).folders).toBe(208);
    expect(resizePanels({ folders: 240, notes: 300 }, "folders", -200, 1400).folders).toBe(208);
});
