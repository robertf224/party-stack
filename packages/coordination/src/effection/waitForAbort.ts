import {
    action,
    type Operation,
} from "effection";
import { abortError } from "../internal.js";

export function waitForAbort(
    signal: AbortSignal
): Operation<never> {
    return action<never>((_resolve, reject) => {
        const abort = () =>
            reject(abortError(signal));
        if (signal.aborted) {
            abort();
            return () => undefined;
        }
        signal.addEventListener("abort", abort, {
            once: true,
        });
        return () =>
            signal.removeEventListener(
                "abort",
                abort
            );
    }, "wait for abort");
}
