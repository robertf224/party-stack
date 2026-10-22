export async function hashKeyPart(value: string): Promise<string> {
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) {
        view.setUint16(index * 2, value.charCodeAt(index));
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of digest) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function r2InstallationPrefix(installationId: string): Promise<string> {
    return `party-stack/ontology-attachments/${await hashKeyPart(installationId)}/`;
}

export async function r2Prefix(options: { installationId: string; ontologyId: string }): Promise<string> {
    return `${await r2InstallationPrefix(options.installationId)}${await hashKeyPart(options.ontologyId)}/`;
}
