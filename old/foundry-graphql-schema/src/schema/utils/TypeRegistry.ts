import { invariant } from "@bobbyfidz/panic";
import type {
    GraphQLFieldConfig,
    GraphQLInputFieldConfig,
    GraphQLInterfaceType,
    GraphQLNamedType,
} from "graphql";

export type GetTypeReference = (name: string) => GraphQLNamedType;

export class TypeRegistry {
    #types: Map<string, GraphQLNamedType> = new Map();

    register = (type: GraphQLNamedType) => {
        this.#types.set(type.name, type);
    };

    // oxlint-disable-next-line typescript/no-explicit-any -- GraphQL registries erase heterogeneous resolver types.
    use = <T extends GraphQLFieldConfig<any, any> | GraphQLInputFieldConfig | GraphQLInterfaceType>(
        fields: (
            getTypeReference: GetTypeReference
        ) => T extends GraphQLInterfaceType ? T[] : Record<string, T>
    ): (() => T extends GraphQLInterfaceType ? T[] : Record<string, T>) => {
        return () => fields(this.#get);
    };

    #get: GetTypeReference = (name) => {
        const type = this.#types.get(name);
        invariant(type, `Type ${name} not found.`);
        return type;
    };
}
