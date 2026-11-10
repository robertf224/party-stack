import { createContext, useContext } from "react";
export const Workspace = createContext<{
    view: string;
    reportError: (message: string) => void;
    requestEditorFocus: (noteId: string) => void;
    claimEditorFocus: (noteId: string) => boolean;
    cancelEditorFocus: () => void;
    focusFolders: () => void;
    formatTarget?: HTMLDivElement | null;
    actionsTarget?: HTMLDivElement | null;
    insertTarget?: HTMLDivElement | null;
}>({
    view: "all",
    reportError: () => {},
    requestEditorFocus: () => {},
    claimEditorFocus: () => false,
    cancelEditorFocus: () => {},
    focusFolders: () => {},
});
export const useWorkspace = () => useContext(Workspace);
