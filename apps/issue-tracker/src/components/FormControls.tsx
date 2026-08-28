import type { ComponentProps } from "react";

type ControlSize = "tiny" | "compact" | "default";

const baseClassName =
    "surface-raised rounded-md border border-slate-200 bg-white text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

const sizeClassNames: Record<ControlSize, string> = {
    tiny: "h-7 px-1.5 text-[11px]",
    compact: "h-8 px-2.5 text-[13px]",
    default: "h-9 px-3 text-sm",
};

type SharedControlProps = {
    controlSize?: ControlSize;
    fullWidth?: boolean;
};

export function FormInput({
    className = "",
    controlSize = "default",
    fullWidth = true,
    ...props
}: ComponentProps<"input"> & SharedControlProps) {
    return (
        <input
            className={`${baseClassName} ${sizeClassNames[controlSize]} ${
                fullWidth ? "w-full" : ""
            } ${className}`}
            {...props}
        />
    );
}

export function FormSelect({
    className = "",
    containerClassName = "",
    controlSize = "default",
    fullWidth = true,
    style,
    ...props
}: ComponentProps<"select"> &
    SharedControlProps & {
        containerClassName?: string;
    }) {
    return (
        <span
            className={`relative inline-block ${
                fullWidth ? "w-full" : ""
            } ${containerClassName}`}
        >
            <select
                className={`${baseClassName} appearance-none ${sizeClassNames[controlSize]} ${
                    fullWidth ? "w-full" : ""
                } ${className}`}
                style={{
                    paddingRight:
                        controlSize === "tiny"
                            ? "1.75rem"
                            : "2rem",
                    ...style,
                }}
                {...props}
            />
            <svg
                aria-hidden
                className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-slate-400 ${
                    controlSize === "tiny"
                        ? "right-2 size-3"
                        : "right-2.5 size-3.5"
                }`}
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
            >
                <path d="m7 10 5 5 5-5" />
            </svg>
        </span>
    );
}

export function FormTextarea({
    className = "",
    fullWidth = true,
    ...props
}: ComponentProps<"textarea"> &
    Pick<SharedControlProps, "fullWidth">) {
    return (
        <textarea
            className={`${baseClassName} ${
                fullWidth ? "w-full" : ""
            } px-3 py-2 text-sm ${className}`}
            {...props}
        />
    );
}
