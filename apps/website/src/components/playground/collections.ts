import { ontologyCollections } from "@party-stack/ontology/tanstack";

export type Todo = { id: string; title: string; done: boolean };
export const { objects } = ontologyCollections<{
    objectTypes: { Todo: Todo };
    actionTypes: {};
    queryFunctionTypes: {};
}>({ Todo: "id" });
