import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigatorNetworkConnectivity } from "./NavigatorNetworkConnectivity.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function setup(initiallyOnline = false) {
    let online = initiallyOnline;
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("navigator", {
        get onLine() {
            return online;
        },
    });
    return {
        connectivity: NavigatorNetworkConnectivity.create(),
        setOnline: (value: boolean) => {
            online = value;
            windowTarget.dispatchEvent(new Event(value ? "online" : "offline"));
        },
    };
}

describe("NavigatorNetworkConnectivity", () => {
    it("waits for an online connection to stabilize", async () => {
        vi.useFakeTimers();
        const { connectivity, setOnline } = setup();
        const listener = vi.fn();
        connectivity.subscribe(listener);

        setOnline(true);
        expect(connectivity.isConnected).toBe(false);
        expect(listener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(999);
        expect(connectivity.isConnected).toBe(false);

        vi.advanceTimersByTime(1);
        expect(connectivity.isConnected).toBe(true);
        expect(listener).toHaveBeenCalledWith(true);
        await connectivity.close();
    });

    it("cancels stabilization when the browser goes offline again", async () => {
        vi.useFakeTimers();
        const { connectivity, setOnline } = setup();

        setOnline(true);
        vi.advanceTimersByTime(500);
        setOnline(false);
        vi.advanceTimersByTime(1_000);

        expect(connectivity.isConnected).toBe(false);
        await connectivity.close();
    });
});
