import { invariant } from "@bobbyfidz/panic";
import {
    LoadObjectSetRequestV2,
    ObjectSet,
    OntologyObjectSets,
    PropertyApiName,
    SelectedPropertyApiName,
} from "@osdk/foundry.ontologies";
import { access, each, ExecutionDetails, ExecutionResults, lambda, object, Step, Maybe } from "grafast";
import { FoundryContext, context } from "../context.js";
import { TypedOntologyObject } from "../utils/TypedOntologyObject.js";

export interface ObjectListStepData {
    data: TypedOntologyObject[];
    nextPageToken?: string;
}

export interface ObjectListArgs {
    pageSize?: number;
    pageToken?: string;
    orderBy?: {
        // TODO: add relevance option
        fields: { field: PropertyApiName; direction: "asc" | "desc" }[];
    };
}

export class LoadedObjectStep extends Step<TypedOntologyObject> {
    static $$export = {
        moduleName: "@bobbyfidz/oql-graphql-schema",
        exportName: "LoadedObjectStep",
    };

    isSyncAndSafe = true;

    #properties = new Set<PropertyApiName>();

    #parentStepId: number;
    #loadStepId: number;

    constructor($parent: Step, $load: Step) {
        super();
        this.#parentStepId = this.addDependency($parent);
        this.#loadStepId = this.addDependency($load);
    }

    get(property: PropertyApiName) {
        this.#properties.add(property);
        return access(this, property);
    }

    optimize() {
        const $load = this.getDep(this.#loadStepId);
        invariant(
            $load instanceof ObjectListStep,
            `LoadedObjectStep could not find its associated ObjectListStep, instead found ${$load.toString()}.`
        );
        $load.addProperties(this.#properties);

        const $parent = this.getDep(this.#parentStepId);
        return $parent;
    }
}

class ObjectListStep extends Step<ObjectListStepData> {
    static $$export = {
        moduleName: "@bobbyfidz/oql-graphql-schema",
        exportName: "ObjectListStep",
    };

    #properties = new Set<PropertyApiName>();

    #contextStepId: number;
    #objectSetStepId: number;
    #argsStep: number;

    constructor($objectSet: Step<ObjectSet>, $args: Step<ObjectListArgs>) {
        super();

        this.#contextStepId = this.addUnaryDependency(context());
        this.#objectSetStepId = this.addDependency($objectSet);
        this.#argsStep = this.addDependency($args);
    }

    addProperties(properties: Set<PropertyApiName>) {
        properties.forEach((property) => this.#properties.add(property));
    }

    execute({ values, indexMap }: ExecutionDetails): ExecutionResults<ObjectListStepData> {
        return indexMap(async (index) => {
            /* eslint-disable @typescript-eslint/no-unsafe-assignment */
            const context: FoundryContext = values[this.#contextStepId]!.at(index);
            const objectSet: ObjectSet = values[this.#objectSetStepId]!.at(index);
            const { pageSize, pageToken, orderBy }: ObjectListArgs = values[this.#argsStep]!.at(index);
            /* eslint-enable @typescript-eslint/no-unsafe-assignment */
            const { data, nextPageToken } = await OntologyObjectSets.load(
                context.client,
                context.ontologyRid,
                {
                    objectSet,
                    select: Array.from(this.#properties) as SelectedPropertyApiName[],
                    pageSize,
                    pageToken,
                    excludeRid: true,
                    orderBy,
                    // Leaving out selectV2
                } as LoadObjectSetRequestV2
            );

            return {
                data: data as TypedOntologyObject[],
                nextPageToken,
            };
        });
    }

    items(): Step<TypedOntologyObject[]> {
        return access(this, "data");
    }

    nextPageToken(): Step<string | undefined> {
        return access(this, "nextPageToken");
    }
}

export function objectListConnection(
    $objectSet: Step<ObjectSet>,
    $args: Step<{
        first: Maybe<number>;
        after: Maybe<string>;
        orderBy: Maybe<{
            fields: { field: PropertyApiName; direction: "asc" | "desc" }[];
        }>;
    }>
) {
    const objectListStep = new ObjectListStep(
        $objectSet,
        lambda(
            $args,
            (args) => ({
                pageSize: args.first ?? undefined,
                pageToken: args.after ?? undefined,
                orderBy: args.orderBy ?? undefined,
            }),
            true
        )
    );
    return object({
        pageInfo: object({
            hasNextPage: lambda(objectListStep.nextPageToken(), (pageToken) => pageToken !== undefined, true),
            endCursor: objectListStep.nextPageToken(),
        }),
        edges: each(objectListStep.items(), (item) =>
            object({
                node: new LoadedObjectStep(item, objectListStep),
            })
        ),
    });
}
