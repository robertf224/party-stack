import { useOntology } from "@party-stack/ontology-react";
import { eq, Query, type QueryResult } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useCallback, useMemo, type ReactNode } from "react";
import { objects } from "../ontology/generated/collections";
import { PreferencesContext, type PanelWidths } from "./context";
import type { NotesOntology } from "../ontology/generated/types";

export function preferencesQuery(userId: string) {
    return new Query()
        .from({ preferences: objects.Preferences })
        .where(({ preferences }) => eq(preferences.id, userId))
        .select(({ preferences }) => ({
            foldersWidth: preferences.foldersWidth,
            notesWidth: preferences.notesWidth,
        }))
        .findOne();
}
type PreferencesData = QueryResult<ReturnType<typeof preferencesQuery>>;
export function PreferencesProvider({ children }: { children: ReactNode }) {
    const ontology = useOntology<NotesOntology>();
    const { data } = useLiveSuspenseQuery(() => preferencesQuery(ontology.context.userId));
    return <PreferencesValue data={data}>{children}</PreferencesValue>;
}
function PreferencesValue({ children, data }: { children: ReactNode; data: PreferencesData | undefined }) {
    const ontology = useOntology<NotesOntology>();
    const setWidths = useCallback(
        (widths: PanelWidths) =>
            ontology.actions.setPanelWidths({
                preferences: ontology.context.userId,
                foldersWidth: Math.round(widths.folders),
                notesWidth: Math.round(widths.notes),
            }),
        [ontology]
    );
    const value = useMemo(
        () => ({ widths: { folders: data?.foldersWidth ?? 240, notes: data?.notesWidth ?? 300 }, setWidths }),
        [data?.foldersWidth, data?.notesWidth, setWidths]
    );
    if (!data) throw new Error("Device preferences are missing.");
    return <PreferencesContext value={value}>{children}</PreferencesContext>;
}
