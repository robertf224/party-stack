import { getUserIdFromToken } from "@bobbyfidz/osdk-utils";
import { envelop, useSchema, useEngine } from "@envelop/core";
import { useParserCache } from "@envelop/parser-cache";
import { useValidationCache } from "@envelop/validation-cache";
import { Client } from "@osdk/client";
import { OntologiesV2 } from "@osdk/foundry.ontologies";
import { execute } from "grafast";
import { parse, validate } from "graphql";
import { GraphQLSchema } from "graphql";
import { FoundryContext } from "./context.js";
import { FoundrySchema } from "./FoundrySchema.js";

export interface ExecutableFoundrySchema {
    schema: GraphQLSchema;
    context: (token: string) => Promise<FoundryContext>;
}

async function create(
    client: Client,
    createRequestClient?: (token: string) => Client
): Promise<ExecutableFoundrySchema> {
    const ontologyRid = (client.__osdkClientContext as unknown as { ontologyRid: string }).ontologyRid;
    const ontology = await OntologiesV2.getFullMetadata(client, ontologyRid);
    const schema = FoundrySchema.create(ontology);
    const context = async (token: string): Promise<FoundryContext> => {
        const requestClient = createRequestClient?.(token) ?? client;
        const userId = getUserIdFromToken(await requestClient.__osdkClientContext.tokenProvider());
        return {
            client: requestClient,
            ontologyRid,
            userId,
        };
    };
    return { schema, context };
}

export type FoundryExecutor = (opts: {
    query: string;
    operationName?: string;
    variables: Record<string, unknown>;
    token: string;
}) => Promise<any>;

function createExecutor(executableFoundrySchema: ExecutableFoundrySchema): FoundryExecutor {
    const { schema, context } = executableFoundrySchema;

    const getEnveloped = envelop({
        plugins: [
            useEngine({ parse, validate, execute }),
            useSchema(schema),
            useParserCache(),
            useValidationCache(),
        ],
    });

    return async ({ query, operationName, variables, token }) => {
        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const { parse, validate, execute, schema } = getEnveloped();

        const document = parse(query);
        const validationErrors = validate(schema, document);

        if (validationErrors.length > 0) {
            return JSON.stringify({ errors: validationErrors });
        }

        const contextValue = await context(token);

        const result = await execute({
            document,
            schema,
            operationName,
            variableValues: variables,
            contextValue,
        });

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return result;
    };
}

export const ExecutableFoundrySchema = {
    create,
    createExecutor,
};
