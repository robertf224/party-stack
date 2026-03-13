import { ActionTypeRid, ActionTypesV2, ActionTypeV2 } from "@osdk/foundry.ontologies";
import { loadOneCallback } from "grafast";
import { FoundryContext } from "../context.js";

export const ActionTypeLoader = loadOneCallback<ActionTypeRid, ActionTypeV2, {}, FoundryContext>(
    async (rids, { unary: context }) => {
        return Promise.all(
            rids.map((rid) => ActionTypesV2.getByRid(context.client, context.ontologyRid, rid))
        );
    }
);
