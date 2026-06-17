import type { ActionTypeName, ObjectTypeName, QueryFunctionTypeName, TypeName } from "./typeNames.js";
import type { OntologyIR } from "../ir/generated/types.js";

// TODO: clean this up a bit when we have a better notion of paths

export type OntologyTypeTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "type";
    name: TypeName<IR>;
};

export type OntologyObjectTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "object";
    name: ObjectTypeName<IR>;
};

export type OntologyObjectPropertyTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "objectProperty";
    objectType: ObjectTypeName<IR>;
    property: string;
};

export type OntologyActionParametersTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "actionParameters";
    actionType: ActionTypeName<IR>;
};

export type OntologyActionParameterTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "actionParameter";
    actionType: ActionTypeName<IR>;
    parameter: string;
};

export type OntologyAttachmentBindingTarget<IR extends OntologyIR = OntologyIR> =
    | OntologyObjectPropertyTarget<IR>
    | OntologyActionParameterTarget<IR>;

export type OntologyAttachmentCreateTarget<IR extends OntologyIR = OntologyIR> =
    OntologyAttachmentBindingTarget<IR>;

export type OntologyQueryFunctionParametersTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "queryFunctionParameters";
    queryFunctionType: QueryFunctionTypeName<IR>;
};

export type OntologyQueryFunctionReturnTarget<IR extends OntologyIR = OntologyIR> = {
    kind: "queryFunctionReturn";
    queryFunctionType: QueryFunctionTypeName<IR>;
};
