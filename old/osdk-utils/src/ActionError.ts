import { ActionValidationError, PalantirApiError } from "@osdk/client";

export type ObjectAlreadyExistsError = Omit<PalantirApiError, "parameters"> & {
    errorName: "ObjectAlreadyExists";
    errorCode: "CONFLICT";
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    parameters: {};
};

export type InvalidParameterValueError = Omit<PalantirApiError, "parameters"> & {
    errorName: "InvalidParameterValue";
    errorCode: "INVALID_ARGUMENT";
    parameters: {
        parameterBaseType: string;
        parameterId: string;
        parameterValue: unknown;
    };
};

export type ParametersNotFoundError = Omit<PalantirApiError, "parameters"> & {
    errorName: "ParametersNotFound";
    errorCode: "INVALID_ARGUMENT";
    parameters: {
        actionType: string;
        unknownParameterIds: string[];
        configuredParameterIds: string[];
    };
};

export type KnownActionError =
    | ActionValidationError
    | ObjectAlreadyExistsError
    | InvalidParameterValueError
    | ParametersNotFoundError;

export type ActionError =
    | ActionValidationError
    | ObjectAlreadyExistsError
    | InvalidParameterValueError
    | ParametersNotFoundError
    | PalantirApiError;

const knownErrorNames = ["ObjectAlreadyExists", "InvalidParameterValue", "ParametersNotFound"] as const;
export function isKnownActionError(error: ActionError): error is KnownActionError {
    return (
        error instanceof ActionValidationError ||
        (error instanceof PalantirApiError &&
            error.errorName !== undefined &&
            knownErrorNames.includes(error.errorName as (typeof knownErrorNames)[number]))
    );
}
