import { linkOptions } from "@tanstack/react-router";

export function collectionLocation(view: string) {
    if (view.startsWith("folder:"))
        return linkOptions({ to: "/folders/$folderId", params: { folderId: view.slice(7) }, search: {} });
    if (view === "trash") return linkOptions({ to: "/trash", search: {} });
    return linkOptions({ to: "/", search: {} });
}

export function noteLocation(view: string, noteId: string) {
    if (view.startsWith("folder:"))
        return linkOptions({
            to: "/folders/$folderId/$noteId",
            params: { folderId: view.slice(7), noteId },
            search: {},
        });
    if (view === "trash") return linkOptions({ to: "/trash/$noteId", params: { noteId }, search: {} });
    return linkOptions({ to: "/notes/$noteId", params: { noteId }, search: {} });
}

export function isNotePath(path: string) {
    return /^\/(?:notes\/[^/]+|trash\/[^/]+|folders\/[^/]+\/[^/]+)\/?$/.test(path);
}
