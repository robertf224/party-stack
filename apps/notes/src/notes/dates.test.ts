import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { createNoteDates } from "./dates";

test("note dates use local calendar groups and Apple Notes-style row labels", () => {
    const dates = createNoteDates({
        now: Temporal.Instant.from("2026-11-06T02:30:00-05:00"),
        timeZone: "America/New_York",
        locale: "en-US",
    });
    for (const [value, group, label] of [
        ["2026-11-06T00:34:00-05:00", "Today", "12:34 AM"],
        ["2026-11-05T00:10:00-05:00", "Yesterday", "Yesterday"],
        ["2026-11-03T12:00:00-05:00", "Previous 7 Days", "Tuesday"],
        ["2026-10-30T12:00:00-04:00", "Previous 7 Days", "Friday"],
        ["2026-10-29T12:00:00-04:00", "Previous 30 Days", "10/29/26"],
        ["2026-10-07T12:00:00-04:00", "Previous 30 Days", "10/7/26"],
        ["2026-10-06T12:00:00-04:00", "October", "10/6/26"],
        ["2026-05-03T12:00:00-04:00", "May", "5/3/26"],
        ["2025-12-30T12:00:00-05:00", "2025", "12/30/25"],
        ["2024-05-03T12:00:00-04:00", "2024", "5/3/24"],
    ]) {
        const instant = Temporal.Instant.from(value!);
        expect(dates.group(instant)).toBe(group);
        expect(dates.label(instant)).toBe(label);
    }
});
test("Yesterday includes the entire 25-hour daylight-saving day", () => {
    const dates = createNoteDates({
        now: Temporal.Instant.from("2026-11-02T00:30:00-05:00"),
        timeZone: "America/New_York",
        locale: "en-US",
    });
    const beforeTheClockChange = Temporal.Instant.from("2026-11-01T00:15:00-04:00");
    expect(dates.group(beforeTheClockChange)).toBe("Yesterday");
    expect(dates.label(beforeTheClockChange)).toBe("Yesterday");
});
