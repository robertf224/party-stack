import {
    byteSource,
    collectByteBlob,
    type ByteInput,
    type BlobBytesService,
} from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";

export class MemoryBlobBytesStore implements BlobBytesService {
    constructor(readonly blobs = new Map<string, Blob>()) {}

    readonly write = (id: string, value: ByteInput) =>
        collectByteBlob(value).pipe(
            Effect.map((blob) => {
                this.blobs.set(id, blob);
            })
        );
    readonly read = (id: string) =>
        Effect.sync(() => {
            const blob = this.blobs.get(id);
            return blob === undefined ? undefined : byteSource(blob);
        });
    readonly delete = (id: string) =>
        Effect.sync(() => {
            this.blobs.delete(id);
        });
}
