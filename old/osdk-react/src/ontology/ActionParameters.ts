import { ActionDefinition } from "@osdk/api";

// TODO: get something like this upstreamed into OSDK.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionParameters<T extends ActionDefinition<any>> =
    T extends ActionDefinition<infer S>
        ? S extends { applyAction: (parameters: infer P) => Promise<unknown> }
            ? P
            : never
        : never;
