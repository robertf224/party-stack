export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result as string);
        };
        reader.onerror = () => {
            reject(new Error(reader.error?.message ?? "Failed to read blob as data URL."));
        };
        reader.readAsDataURL(blob);
    });
}
