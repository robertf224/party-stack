import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { ChevronDown, X } from "lucide-react";
import { ViewTransition, useContext, useSyncExternalStore, type ComponentProps } from "react";
import { BootContext } from "./bootContext";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export const textError = (error: unknown) =>
    error instanceof Error ? error.message : "Something went wrong.";
export function GlassButton({
    icon,
    children,
    className = "",
    ...props
}: ComponentProps<typeof Button> & { icon?: ReactNode }) {
    return (
        <Button className={`glass-control ${className}`} {...props}>
            {icon}
            {children}
        </Button>
    );
}
export function IconButton({
    label,
    children,
    active,
    className = "",
    ...props
}: { label: string; children: ReactNode; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <GlassButton
            type="button"
            className={`icon-button glass-button${active ? " active" : ""} ${className}`}
            title={label}
            aria-label={label}
            aria-pressed={active}
            {...props}
        >
            {children}
        </GlassButton>
    );
}
const subscribeVisibility = (notify: () => void) => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", notify);
    motion.addEventListener("change", notify);
    return () => {
        document.removeEventListener("visibilitychange", notify);
        motion.removeEventListener("change", notify);
    };
};
export function DialogHeader({ title, closeLabel }: { title: string; closeLabel: string }) {
    return (
        <header className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close
                render={
                    <IconButton label={closeLabel}>
                        <X size={20} />
                    </IconButton>
                }
            />
        </header>
    );
}
export function DialogBackdrop() {
    return <Dialog.Backdrop className="dialog-backdrop" forceRender />;
}
// Keep the boundary mounted: replacing it with its children would remount
// providers and editors whenever page visibility or reduced motion changes.
export function VisibleViewTransition({
    duringStartup = false,
    ...props
}: ComponentProps<typeof ViewTransition> & { duringStartup?: boolean }) {
    const { ready } = useContext(BootContext);
    const visible = useSyncExternalStore(
        subscribeVisibility,
        () =>
            document.visibilityState === "visible" && !matchMedia("(prefers-reduced-motion: reduce)").matches,
        () => false
    );
    // The hidden workspace may mount through several Suspense boundaries.
    // Animating those commits delays React's effects (including the ready
    // signal) and queues the actual reveal behind an invisible animation.
    // Only the splash and its owning reveal boundary animate during startup.
    const animate = visible && (ready || duringStartup);
    return (
        <ViewTransition
            {...props}
            default={animate ? props.default : "none"}
            enter={animate ? props.enter : "none"}
            exit={animate ? props.exit : "none"}
            update={animate ? props.update : "none"}
            share={animate ? props.share : "none"}
        />
    );
}
const subscribeCompact = (notify: () => void) => {
    const media = matchMedia("(max-width: 1000px)");
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
};
export function useCompactLayout() {
    return useSyncExternalStore(
        subscribeCompact,
        () => matchMedia("(max-width: 1000px)").matches,
        () => false
    );
}
const subscribeMobile = (notify: () => void) => {
    const media = matchMedia("(max-width: 700px)");
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
};
export function useMobileLayout() {
    return useSyncExternalStore(
        subscribeMobile,
        () => matchMedia("(max-width: 700px)").matches,
        () => false
    );
}
export function NotesMark({ className = "" }: { className?: string }) {
    return <img className={`notes-mark ${className}`} src="/favicon.svg" alt="" aria-hidden="true" />;
}
export function BrandMark() {
    const { ready } = useContext(BootContext);
    const mark = (
        <span className="brand-mark">
            <NotesMark />
        </span>
    );
    if (!ready) return mark;
    return (
        <VisibleViewTransition name="notes-app-icon" default="none" share="notes-icon-move">
            {mark}
        </VisibleViewTransition>
    );
}
export function Splash() {
    return (
        <VisibleViewTransition duringStartup default="none" exit="notes-fade">
            <div className="opening" role="status" aria-label="Opening">
                <VisibleViewTransition
                    duringStartup
                    name="notes-app-icon"
                    default="none"
                    share="notes-icon-move"
                >
                    <span className="splash-icon">
                        <NotesMark />
                    </span>
                </VisibleViewTransition>
            </div>
        </VisibleViewTransition>
    );
}
export function EditorLoading() {
    const { ready } = useContext(BootContext);
    const mobile = useMobileLayout();
    if (!ready) return null;
    return mobile ? <Splash /> : <div className="editor-loading" role="status" aria-label="Opening note" />;
}
export function CompactSelect({
    label,
    value,
    items,
    onChange,
    disabled,
}: {
    label: string;
    value: string;
    items: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return (
        <Select.Root
            items={items}
            value={value}
            onValueChange={(value) => {
                if (value !== null) onChange(value);
            }}
            disabled={disabled}
        >
            <Select.Trigger className="select-trigger" aria-label={label}>
                <Select.Value />
                <Select.Icon>
                    <ChevronDown size={12} />
                </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Positioner className="menu-positioner" sideOffset={5} alignItemWithTrigger={false}>
                    <Select.Popup className="glass-menu select-popup">
                        <Select.List>
                            {items.map((item) => (
                                <Select.Item key={item.value} value={item.value} className="menu-item">
                                    <Select.ItemText>{item.label}</Select.ItemText>
                                </Select.Item>
                            ))}
                        </Select.List>
                    </Select.Popup>
                </Select.Positioner>
            </Select.Portal>
        </Select.Root>
    );
}
