import { ScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, RefObject } from "react";

export function NoteListScroll({
    children,
    viewportRef,
}: {
    children: ReactNode;
    viewportRef?: RefObject<HTMLDivElement | null>;
}) {
    return (
        <ScrollArea.Root className="note-list-scroll-area">
            <ScrollArea.Viewport
                className="note-list-scroll"
                ref={viewportRef}
                style={{ overflowX: "hidden", overflowY: "auto" }}
            >
                <ScrollArea.Content style={{ minWidth: 0 }}>{children}</ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar
                className="note-list-scrollbar"
                style={{ top: "var(--list-fixed-height)", bottom: 3 }}
            >
                <ScrollArea.Thumb className="note-list-scroll-thumb" />
            </ScrollArea.Scrollbar>
        </ScrollArea.Root>
    );
}
