import { expect, test } from "vite-plus/test";
import { GeolocationError, geolocationErrorCode } from "./Geolocation.js";

test("geolocation reasons map to the web API's error codes", () => {
    expect(
        (["PermissionDenied", "PositionUnavailable", "Timeout"] as const).map(geolocationErrorCode)
    ).toEqual([1, 2, 3]);
    expect(new GeolocationError({ reason: "Timeout", message: "Too slow." })).toMatchObject({
        _tag: "GeolocationError",
        reason: "Timeout",
    });
});
