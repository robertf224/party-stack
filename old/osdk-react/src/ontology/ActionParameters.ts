import { ActionDefinition } from "@osdk/api";

// TODO: get something like this upstreamed into OSDK.
// oxlint-disable-next-line typescript/no-explicit-any
export type ActionParameters<T extends ActionDefinition<any>> =
    T extends ActionDefinition<infer S>
        ? S extends { applyAction: (parameters: infer P) => Promise<unknown> }
            ? P
            : never
        : never;
