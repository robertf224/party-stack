import { Temporal } from "temporal-polyfill";

export function createNoteDates({
    now = Temporal.Now.instant(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale,
}: { now?: Temporal.Instant; timeZone?: string; locale?: string } = {}) {
    const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
    const age = (time: Temporal.Instant) => today.since(time.toZonedDateTimeISO(timeZone).toPlainDate()).days;
    const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
    const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" });
    const date = new Intl.DateTimeFormat(locale, {
        timeZone,
        month: "numeric",
        day: "numeric",
        year: "2-digit",
    });
    const month = new Intl.DateTimeFormat(locale, { timeZone, month: "long" });
    const full = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "full", timeStyle: "short" });
    return {
        group(value: Temporal.Instant) {
            const days = age(value);
            if (days <= 0) return "Today";
            if (days === 1) return "Yesterday";
            if (days <= 7) return "Previous 7 Days";
            if (days <= 30) return "Previous 30 Days";
            const year = value.toZonedDateTimeISO(timeZone).year;
            return year === today.year ? month.format(value.epochMilliseconds) : String(year);
        },
        label(value: Temporal.Instant) {
            const days = age(value);
            if (days <= 0) return time.format(value.epochMilliseconds);
            if (days === 1) return "Yesterday";
            if (days <= 7) return weekday.format(value.epochMilliseconds);
            return date.format(value.epochMilliseconds);
        },
        full: (value: Temporal.Instant) => full.format(value.epochMilliseconds),
    };
}
