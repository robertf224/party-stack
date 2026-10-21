/** Byte-store misses are distinct from permission, connectivity and IO failures. */
export class BlobBytesNotFoundError extends Error {
    constructor(
        readonly id: string,
        options?: ErrorOptions
    ) {
        super(`Blob bytes not found for "${id}".`, options);
        this.name = "BlobBytesNotFoundError";
    }
}
