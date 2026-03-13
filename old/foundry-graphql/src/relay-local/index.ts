import { ExecutableFoundrySchema } from "@bobbyfidz/foundry-graphql-schema";
import { invariant } from "@bobbyfidz/panic";
import { Client } from "@osdk/client";
import { FetchFunction, Network } from "relay-runtime";

export function createNetwork(client: Client): ReturnType<typeof Network.create> {
    const executorPromise = ExecutableFoundrySchema.create(client).then(
        ExecutableFoundrySchema.createExecutor
    );
    const fetchFunction: FetchFunction = async (request, variables) => {
        invariant(request.text, "Query text is required.");
        const executor = await executorPromise;
        const token = await client.__osdkClientContext.tokenProvider();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const result = await executor({
            query: request.text,
            operationName: request.name,
            variables,
            token,
        });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return result;
    };
    return Network.create(fetchFunction);
}

export { missingFieldHandlers } from "../relay-shared/index.js";
