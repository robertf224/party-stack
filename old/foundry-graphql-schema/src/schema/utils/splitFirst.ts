import { invariant } from "@bobbyfidz/panic";

export function splitFirst(str: string, delimiter: string): [string, string] {
    const index = str.indexOf(delimiter);
    invariant(index !== -1, `Delimiter ${delimiter} not found in ${str}.`);
    return [str.substring(0, index), str.substring(index + 1)];
}
