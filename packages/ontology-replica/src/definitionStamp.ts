import { ontologyDefinitionHash } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Stream } from "effect";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** Replica heads are rewritten on every sequence and cursor advance. Store a
 * compact definition stamp there and keep the full signature, needed only to
 * compare a changed definition's contract, in its own row written on change.
 * Heads written before this format still hold the full signature.
 */
export const definitionStampPrefix = "sha256:";
export const definitionStamp = (ir: OntologyIR) =>
    Effect.map(ontologyDefinitionHash(ir), (hash) => `${definitionStampPrefix}${hash}`);
export const isDefinitionStamp = (stored: string) => stored.startsWith(definitionStampPrefix);
export const definitionTable = (name: (part: string) => string) =>
    Table.make<{ signature: string }>({ name: name("definition") });
/** The stamp of an already computed full definition signature. */
export const signatureStamp = (signature: string) =>
    Effect.map(
        digestBytes({ type: "application/json", stream: Stream.make(new TextEncoder().encode(signature)) }),
        (hash) => `${definitionStampPrefix}${hash}`
    );
