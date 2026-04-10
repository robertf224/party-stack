import { ObjectTypesV2 } from "@osdk/foundry.ontologies";
import { createClient, createOntologyClient } from "@party-stack/foundry-client";

async function smoke() {
    // Read from .env.local
    const client = createOntologyClient({});
    const page = ObjectTypesV2.getEditsHistory(
        client,
        client.ontologyRid,
        "Task",
        {},
        {
            preview: true,
        }
    );
}
