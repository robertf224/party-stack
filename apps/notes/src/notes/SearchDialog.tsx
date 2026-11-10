import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
import { Search } from "lucide-react";
import { Suspense, useDeferredValue, useId, useRef, useState, type RefObject } from "react";
import { Results } from "./SearchResults";
import { DialogBackdrop, DialogHeader } from "./ui";

export function SearchDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <DialogBackdrop />
                <Dialog.Popup className="glass-dialog search-dialog" initialFocus={input}>
                    <SearchContent input={input} close={() => onOpenChange(false)} />
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
function SearchContent({ close, input }: { close: () => void; input: RefObject<HTMLInputElement | null> }) {
    const inputId = useId();
    const [search, setSearch] = useState("");
    const query = useDeferredValue(search);
    return (
        <>
            <DialogHeader title="Search notes" closeLabel="Close search" />
            <label className="search modal-search" htmlFor={inputId}>
                <Search size={20} />
                <Input
                    aria-label="Search all notes"
                    placeholder="Search"
                    id={inputId}
                    ref={input}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            document.querySelector<HTMLAnchorElement>(".search-results a")?.focus();
                        }
                    }}
                />
            </label>
            <div className="search-results" aria-busy={query !== search}>
                <Suspense fallback={<output className="search-loading" aria-label="Searching notes" />}>
                    <Results search={query} close={close} />
                </Suspense>
            </div>
        </>
    );
}
