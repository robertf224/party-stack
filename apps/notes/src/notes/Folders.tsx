import { useOntology, type FragmentRef } from "@party-stack/ontology-react";
import { eq } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { Folder } from "lucide-react";
import { Suspense, type ReactElement, type ReactNode } from "react";
import { defaultNotebookId } from "../ontology/folders";
import { objects } from "../ontology/generated/collections";
import { downloadFolder } from "./downloadFolder";
import { DownloadStatus } from "./DownloadStatus";
import { FolderLink, folderLinkFragment } from "./FolderLink";
import type { NotesOntology } from "../ontology/generated/types";

type FolderRow = {
    id: string;
    link: FragmentRef<typeof folderLinkFragment>;
    pinId?: string;
    ready?: boolean;
    error?: unknown;
};
type Props = {
    nav: (id: string, name: string, icon: ReactNode, trailing?: ReactNode) => ReactElement;
    folders: readonly FolderRow[];
};

function FolderRows({ nav, folders }: Props) {
    const ontology = useOntology<NotesOntology>();
    const defaultId = defaultNotebookId(ontology.context.userId);
    const indicator = (folder?: FolderRow) =>
        folder?.pinId && folder.ready && !folder.error ? <DownloadStatus compact status="ready" /> : null;
    return (
        <>
            {nav(
                "all",
                "Notes",
                <Folder style={{ color: "var(--accent)" }} />,
                indicator(folders.find((folder) => folder.id === defaultId))
            )}
            {folders
                .filter((folder) => folder.id !== defaultId)
                .map((folder) => (
                    <FolderLink key={folder.id} folder={folder.link} nav={nav} trailing={indicator(folder)} />
                ))}
        </>
    );
}

function DownloadedFolders({ nav }: Pick<Props, "nav">) {
    const ontology = useOntology();
    const downloads = ontology.pins(downloadFolder);
    const { data: folders } = useLiveSuspenseQuery((q) =>
        q
            .from({ folder: objects.Notebook })
            .leftJoin({ pin: downloads.collection }, ({ folder, pin }) => eq(folder.id, pin.inputs.folderId))
            .orderBy(({ folder }) => folder.name, "asc")
            .select(({ folder, pin }) => ({
                id: folder.id,
                link: folderLinkFragment.include(folder),
                pinId: pin.id,
                ready: pin.ready,
                error: pin.error,
            }))
    );
    return <FolderRows nav={nav} folders={folders} />;
}

export function Folders(props: Props) {
    // The folders are already loaded by the layout. Acquiring the status view
    // must not hide navigation while its first snapshot is arriving.
    return (
        <Suspense fallback={<FolderRows {...props} />}>
            <DownloadedFolders nav={props.nav} />
        </Suspense>
    );
}
