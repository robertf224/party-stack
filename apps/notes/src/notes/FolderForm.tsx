import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useOntology } from "@party-stack/ontology-react";
import { useNavigate } from "@tanstack/react-router";
import { Check, FolderPlus, Palette } from "lucide-react";
import { useState, type RefObject } from "react";
import { collectionLocation } from "./navigation";
import { GlassButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";
import type { Folder } from "./FolderMenu";

const folderColors = [
    ["Gold", "#d4a72c"],
    ["Blue", "#829bbc"],
    ["Green", "#72a98a"],
    ["Purple", "#a394bf"],
    ["Rose", "#c9809c"],
    ["Orange", "#d79965"],
] as const;

export function FolderForm({
    folder,
    close,
    nameInput,
}: {
    folder?: Folder;
    close: () => void;
    nameInput?: RefObject<HTMLInputElement | null>;
}) {
    const ontology = useOntology<NotesOntology>();
    const { reportError } = useWorkspace();
    const navigate = useNavigate();
    const [name, setName] = useState(folder?.name ?? "");
    const [color, setColor] = useState<string>(folder?.color ?? folderColors[0][1]);
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                if (folder)
                    void ontology.actions
                        .updateNotebook({ notebook: folder.id, name: name.trim(), color })
                        .catch((cause) => reportError(textError(cause)));
                else {
                    const id = crypto.randomUUID();
                    void ontology.actions
                        .createNotebook({ id, name: name.trim(), color })
                        .catch((cause) => reportError(textError(cause)));
                    void navigate(collectionLocation(`folder:${id}`));
                }
                close();
            }}
        >
            <Input
                ref={nameInput}
                aria-label="Folder name"
                placeholder="Folder name"
                value={name}
                onChange={(event) => setName(event.target.value)}
            />
            <fieldset className="folder-color-field">
                <div className="folder-color-options">
                    <RadioGroup
                        aria-label="Folder color"
                        value={color}
                        onValueChange={setColor}
                        className="folder-colors"
                    >
                        {folderColors.map(([label, value]) => (
                            <Radio.Root
                                key={value}
                                value={value}
                                aria-label={label}
                                className="folder-color"
                                style={{ backgroundColor: value }}
                            >
                                <Radio.Indicator>
                                    <Check size={16} />
                                </Radio.Indicator>
                            </Radio.Root>
                        ))}
                    </RadioGroup>
                    <label
                        className="custom-folder-color"
                        title="Custom color"
                        data-selected={!folderColors.some(([, value]) => value === color) || undefined}
                        style={{ color }}
                    >
                        <Palette size={19} />
                        <input
                            type="color"
                            aria-label="Custom folder color"
                            value={color}
                            onChange={(event) => setColor(event.target.value)}
                        />
                    </label>
                </div>
            </fieldset>
            <div className="dialog-actions">
                <Dialog.Close render={<GlassButton>Cancel</GlassButton>} />
                <GlassButton
                    disabled={!name.trim()}
                    type="submit"
                    icon={folder ? <Check size={17} /> : <FolderPlus size={17} />}
                >
                    {folder ? "Save changes" : "Create folder"}
                </GlassButton>
            </div>
        </form>
    );
}
