import { MissingFieldHandler, ROOT_TYPE } from "relay-runtime";

// TODO: add auto-generated missing field handlers.
export const missingFieldHandlers: MissingFieldHandler[] = [
    {
        handle: (field, parent, args): string | undefined => {
            if (parent && parent.getType() === ROOT_TYPE && field.name === "node" && "_id" in args) {
                return args._id as string;
            }
        },
        kind: "linked",
    },
];
