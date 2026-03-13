import { constant, inhibitOnNull, list, loadOne } from "grafast";
import { NodeIdCodec, NodeIdHandler, LoadOneCallback, LoadedRecordStep, ListStep, Step } from "grafast";
import { context, FoundryContext } from "../context.js";
import { splitFirst } from "../utils/splitFirst.js";

const BASIC_CODEC: NodeIdCodec = {
    name: "basic-codec",
    encode: (id: [string, string]) => id.join(":"),
    decode: (id: string) => splitFirst(id, ":"),
};

function createBasicHandler(
    typeName: string,
    idFieldName: string,
    loader: LoadOneCallback<string, any, {}, FoundryContext>
): NodeIdHandler {
    return {
        typeName,
        codec: BASIC_CODEC,
        // Create a structured id from the object.
        plan: ($object: LoadedRecordStep<any>) => {
            return list([constant(typeName), $object.get(idFieldName)]);
        },
        // Check if structured id is for our type.
        match(list: [string, string]) {
            return list[0] === typeName;
        },
        // Get the narrowed id from the structured id.
        getSpec($list: ListStep<[Step<string>, Step<string>]>): Step<string> {
            return $list.at(1);
        },
        // Fetch the object by id.
        get($id: Step<string>) {
            return loadOne(inhibitOnNull($id), context(), loader);
        },
        // TODO: figure out what this is.
        getIdentifiers: () => [],
    };
}

export const NodeHandlers = {
    createBasicHandler,
};
