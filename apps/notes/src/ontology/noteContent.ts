/** Preserve the old plain-text label when joining the former title/body fields. */
export function joinNoteMarkdown(title: string, body: string): string {
    const escaped = title.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
    return escaped ? `${escaped}${body ? `\n\n${body}` : ""}` : body;
}
