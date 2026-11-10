import { ontologyCollections } from "@party-stack/ontology";
import type { FoundryPlatformOntology } from "./platform.js";

export const { objects: foundryPlatformObjects } = ontologyCollections<FoundryPlatformOntology>({
    Ontology: "id",
});
