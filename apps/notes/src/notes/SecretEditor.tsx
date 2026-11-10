import {
    defineFragment,
    useFragment,
    useOntology,
    type FragmentData,
    type FragmentRef,
} from "@party-stack/ontology-react";
import { Eye, EyeOff, KeyRound, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { objects } from "../ontology/generated/collections";
import { GlassButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

export const secretEditorFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    title: note.title,
    kind: note.kind,
    secret: note.secret,
    trashed: note.trashed,
}));

export function SecretEditor({ note }: { note: FragmentRef<typeof secretEditorFragment> }) {
    const { data: value } = useFragment(note);
    return value && value.kind !== "note" ? <SecretEditorContent value={value} /> : null;
}

function SecretEditorContent({ value: note }: { value: FragmentData<typeof secretEditorFragment> }) {
    const ontology = useOntology<NotesOntology>();
    const { reportError, claimEditorFocus } = useWorkspace();
    const { kind, secret, trashed: readOnly } = note;
    const [titleDraft, setTitleDraft] = useState<string>();
    const titleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latestTitle = useRef({ value: note.title, dirty: false });
    const flushTitle = () => {
        clearTimeout(titleTimer.current);
        if (!latestTitle.current.dirty) return;
        latestTitle.current.dirty = false;
        void ontology.actions
            .updateNote({ note: note.id, title: latestTitle.current.value })
            .catch((cause) => reportError(textError(cause)));
    };
    useEffect(() => () => flushTitle(), []);
    const [revealed, setRevealed] = useState(!secret);
    const [value, setValue] = useState(() =>
        !secret && kind === "login" ? JSON.stringify({ username: "", password: "", url: "" }) : ""
    );
    const [busy, setBusy] = useState(false);
    const [changed, setChanged] = useState(false);
    async function reveal() {
        setBusy(true);
        try {
            setValue(
                secret
                    ? await ontology.decrypt(secret)
                    : kind === "login"
                      ? JSON.stringify({ username: "", password: "", url: "" })
                      : ""
            );
            setRevealed(true);
        } catch (error) {
            reportError(textError(error));
        } finally {
            setBusy(false);
        }
    }
    async function commit() {
        setBusy(true);
        try {
            const sealed = await ontology.queryFunctions.sealSecret({ value });
            await ontology.actions.updateNote({ note: note.id, secret: sealed });
            setChanged(false);
        } catch (error) {
            reportError(textError(error));
        } finally {
            setBusy(false);
        }
    }
    let login = { username: "", password: "", url: "" };
    if (kind === "login" && revealed) {
        try {
            login = JSON.parse(value);
        } catch {}
    }
    return (
        <>
            <input
                className="note-title"
                ref={(input) => {
                    if (input && claimEditorFocus(note.id)) input.focus();
                }}
                aria-label="Note title"
                placeholder="Untitled"
                readOnly={readOnly}
                value={titleDraft ?? note.title}
                onFocus={() => setTitleDraft(note.title)}
                onChange={(event) => {
                    const value = event.target.value;
                    setTitleDraft(value);
                    latestTitle.current = { value, dirty: true };
                    clearTimeout(titleTimer.current);
                    titleTimer.current = setTimeout(flushTitle, 350);
                }}
                onBlur={() => {
                    flushTitle();
                    setTitleDraft(undefined);
                }}
            />
            <section className={`secret-card ${revealed ? "revealed" : ""}`}>
                <div className="secret-heading">
                    <span className="secret-icon">{kind === "login" ? <KeyRound /> : <LockKeyhole />}</span>
                    <div>
                        <h2>{kind === "login" ? "Encrypted login" : "Encrypted note"}</h2>
                        <p>
                            {revealed
                                ? "Only revealed in this view"
                                : "Your details stay encrypted until you reveal them."}
                        </p>
                    </div>
                    <GlassButton
                        onClick={() => {
                            if (revealed) {
                                setRevealed(false);
                                setValue("");
                                setChanged(false);
                            } else void reveal();
                        }}
                        disabled={busy}
                    >
                        {revealed ? (
                            <>
                                <EyeOff size={14} />
                                Hide
                            </>
                        ) : (
                            <>
                                <Eye size={14} />
                                {busy ? "Opening…" : "Reveal"}
                            </>
                        )}
                    </GlassButton>
                </div>
                {revealed && (
                    <div className="secret-fields">
                        {kind === "login" ? (
                            (Object.keys(login) as (keyof typeof login)[]).map((key) => (
                                <label key={key}>
                                    {key}
                                    <input
                                        aria-label={key}
                                        value={login[key]}
                                        autoComplete="off"
                                        readOnly={readOnly}
                                        onChange={(event) => {
                                            setValue(JSON.stringify({ ...login, [key]: event.target.value }));
                                            setChanged(true);
                                        }}
                                    />
                                </label>
                            ))
                        ) : (
                            <textarea
                                readOnly={readOnly}
                                aria-label="Secure note content"
                                placeholder="Write something private…"
                                value={value}
                                onChange={(event) => {
                                    setValue(event.target.value);
                                    setChanged(true);
                                }}
                            />
                        )}
                        <div className="secret-footer">
                            <span>
                                <LockKeyhole size={12} />
                                Encrypted before saving
                            </span>
                            <GlassButton
                                disabled={!changed || busy || readOnly}
                                onClick={() => void commit()}
                            >
                                {busy ? "Saving…" : "Save changes"}
                            </GlassButton>
                        </div>
                    </div>
                )}
            </section>
        </>
    );
}
