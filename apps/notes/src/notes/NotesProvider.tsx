import { OntologyProvider } from "@party-stack/ontology-react";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { notesOptions } from "./options";
import { UserTraceRecorder } from "./UserTraceRecorder";
import type { NotesOntology } from "../ontology/generated/types";
import type { ReactNode } from "react";

export function NotesProvider({ children }: { children: ReactNode }) {
    return (
        <OntologyProvider<NotesOntology> {...notesOptions}>
            {import.meta.env.DEV && <UserTraceRecorder />}
            <PreferencesProvider>{children}</PreferencesProvider>
        </OntologyProvider>
    );
}
