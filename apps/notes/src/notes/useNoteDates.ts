import { useEffect, useMemo, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { createNoteDates } from "./dates";

export function useNoteDates() {
    const [today, setToday] = useState(() => Temporal.Now.plainDateISO().toString());
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {
            clearTimeout(timer);
            const current = Temporal.Now.zonedDateTimeISO();
            const next = current.add({ days: 1 }).startOfDay();
            timer = setTimeout(refresh, next.epochMilliseconds - current.epochMilliseconds);
        };
        function refresh() {
            setToday(Temporal.Now.plainDateISO().toString());
            schedule();
        }
        const visible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        schedule();
        document.addEventListener("visibilitychange", visible);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", visible);
        };
    }, []);
    return useMemo(() => createNoteDates(), [today]);
}
