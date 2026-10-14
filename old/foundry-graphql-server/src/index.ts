import "dotenv/config";
import { createServer } from "node:http";
import { ExecutableFoundrySchema } from "@bobbyfidz/foundry-graphql-schema";
import { grafserv } from "grafserv/node";
import { getFoundryClient } from "./getFoundryClient.js";

export async function start() {
    const client = getFoundryClient();
    const { schema, context } = await ExecutableFoundrySchema.create(client, () => client);

    const serv = grafserv({
        schema,
        preset: {
            grafast: {
                context,
                explain: true,
            },
            grafserv: {
                graphiql: true,
            },
        },
    });

    const server = createServer();
    server.on("error", (e) => {
        console.error(e);
    });
    serv.addTo(server).catch((e) => {
        console.error(e);
        process.exit(1);
    });
    server.listen(8080);
}

start().catch(console.error);
