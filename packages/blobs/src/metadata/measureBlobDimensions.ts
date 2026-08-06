import { imageDimensionsFromStream } from "image-dimensions";
import type { BlobDimensions } from "../types.js";

export async function measureBlobDimensions(blob: Blob): Promise<BlobDimensions> {
    const dimensions = await imageDimensionsFromStream(blob.stream());
    if (!dimensions) {
        throw new Error(
            `Unable to determine dimensions for blob type "${blob.type || "(empty)"}".`
        );
    }
    return {
        width: dimensions.width,
        height: dimensions.height,
    };
}
