import * as Alchemy from "alchemy";
import { providers, state } from "alchemy/Cloudflare";
import { Effect } from "effect";
import Worker from "./worker.js";

export default Alchemy.Stack(
    "ontology-example",
    { providers: providers(), state: state() },
    Effect.gen(function* () {
        const worker = yield* Worker;
        return { url: worker.url };
    })
);
