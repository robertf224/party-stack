import { Context, Effect, Exit, Semaphore } from "effect";
import { transactionError } from "./errors.js";
import type { OntologyStorageError } from "./errors.js";
import type { TablesService, Transaction } from "./tables.js";
import type { Cause } from "effect";

/** Private identity survives service spreads/decorators without exposing an application API. */
export const TransactionIdentity: unique symbol = Symbol("TablesTransactionIdentity");
type Identity = symbol | TablesService;
export interface TransactionState {
    readonly tx: Transaction;
    readonly writable: boolean;
    /** One wrapper per object-storage service touched in this physical transaction. */
    readonly bindings: Map<symbol, unknown>;
    readonly invalidate: (cause: Cause.Cause<OntologyStorageError>) => void;
    readonly mutation: <A>(
        effect: Effect.Effect<A, OntologyStorageError>
    ) => Effect.Effect<A, OntologyStorageError>;
}
interface OwnedTransactionState extends TransactionState {
    readonly complete: Effect.Effect<void, OntologyStorageError>;
}
export const CurrentTransactions = Context.Reference<ReadonlyMap<Identity, TransactionState>>(
    "@party-stack/ontology-storage/CurrentTransactions",
    { defaultValue: () => new Map() }
);

/** Scope rollback-only state and complete object mutations to the physical transaction. */
export const provideTransaction = Effect.fnUntraced(function* <A, E, R>(
    identity: Identity,
    tx: Transaction,
    writable: boolean,
    body: (state: TransactionState) => Effect.Effect<A, E, R>
): Effect.fn.Return<A, E | OntologyStorageError, R> {
    const active = yield* CurrentTransactions;
    const gate = Semaphore.makeUnsafe(1);
    let failed: Cause.Cause<OntologyStorageError> | undefined;
    const state: OwnedTransactionState = {
        tx,
        writable,
        bindings: new Map(),
        invalidate: (cause) => {
            failed ??= cause;
        },
        mutation: (effect) =>
            gate.withPermits(1)(
                Effect.suspend(() =>
                    failed
                        ? Effect.failCause(failed)
                        : writable
                          ? effect
                          : Effect.fail(transactionError("ReadOnly", "Read-only transaction"))
                ).pipe(
                    Effect.onExit((exit) =>
                        Effect.sync(() => {
                            if (Exit.isFailure(exit)) failed ??= exit.cause;
                        })
                    )
                )
            ),
        complete: Effect.suspend(() => (failed ? Effect.failCause(failed) : Effect.void)),
    };
    return yield* body(state).pipe(
        Effect.tap(() => state.complete),
        Effect.provideService(CurrentTransactions, new Map([...active, [identity, state]]))
    );
});

/** Service operations join ambient transactions; only explicit boundaries reject nesting. */
export const useTransaction = Effect.fnUntraced(function* <A, E, R>(
    tables: TablesService,
    writable: boolean,
    body: (state: TransactionState) => Effect.Effect<A, E, R>
): Effect.fn.Return<A, E | OntologyStorageError, R> {
    const identity = tables[TransactionIdentity] ?? tables;
    const active = yield* CurrentTransactions;
    const existing = active.get(identity);
    if (existing) return yield* body(existing);
    const inside = (tx: Transaction) =>
        Effect.flatMap(CurrentTransactions, (current) => {
            const state = current.get(identity);
            return state ? body(state) : provideTransaction(identity, tx, writable, body);
        });
    return yield* writable ? tables.transaction(inside) : tables.read((tx) => inside(tx as Transaction));
});
