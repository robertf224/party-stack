export type ArrayElement<T> = T extends readonly (infer Element)[] ? Element : never;

export type NamedTypes<Ontology> = Ontology extends { readonly types: infer Types }
    ? ArrayElement<Types>
    : never;

export type ObjectTypes<Ontology> = Ontology extends { readonly objectTypes: infer ObjectTypes }
    ? ArrayElement<ObjectTypes>
    : never;

export type ActionTypes<Ontology> = Ontology extends { readonly actionTypes: infer ActionTypes }
    ? ArrayElement<ActionTypes>
    : never;

export type QueryFunctionTypes<Ontology> =
    Ontology extends { readonly queryFunctionTypes: infer QueryFunctionTypes }
        ? ArrayElement<QueryFunctionTypes>
        : never;

export type TypeName<Ontology> =
    NamedTypes<Ontology> extends { readonly name: infer Name } ? Extract<Name, string> : never;

export type ObjectTypeName<Ontology> =
    ObjectTypes<Ontology> extends { readonly name: infer Name } ? Extract<Name, string> : never;

export type ActionTypeName<Ontology> =
    ActionTypes<Ontology> extends { readonly name: infer Name } ? Extract<Name, string> : never;

export type QueryFunctionTypeName<Ontology> =
    QueryFunctionTypes<Ontology> extends { readonly name: infer Name }
        ? Extract<Name, string>
        : never;
