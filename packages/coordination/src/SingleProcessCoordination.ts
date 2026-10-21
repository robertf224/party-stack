import { Effect, Exit, Scope } from "effect";
import { BaseCoordination, type InvocationContext } from "./base.js";
import {
    CoordinationClosedError,
    type CoordinationCallOptions,
    type CoordinationHost,
    type CoordinationOptions,
    type CoordinationService,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
} from "./contracts.js";
import { HostCore } from "./host-core.js";
import { normalizeError, randomId } from "./internal.js";
import { runInEffectScope } from "./resources/runInScope.js";

export class SingleProcessCoordination extends BaseCoordination implements CoordinationHost {
    readonly role = "host" as const;
    readonly isLeader = true;
    readonly scope: string;

    private readonly nodeId = randomId();
    private readonly core: HostCore;
    private readonly lifetimeScope = Effect.runSync(Scope.make());
    private closePromise?: Promise<void>;

    constructor(options: CoordinationOptions) {
        super();
        this.scope = options.scope;
        this.core = new HostCore({
            contextClient: (path, signal) => this.createContextClient({ path, signal }),
            publishEvent: (namespace, event, payload) => this.emitEvent(namespace, event, payload),
        });
        Effect.runSync(
            Scope.addFinalizer(
                this.lifetimeScope,
                Effect.promise(() => this.core.close())
            )
        );
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        this.assertOpen();
        return this.core.serve(namespace, handlers);
    }

    runAsLeader<Result>(
        callback: (context: { signal: AbortSignal }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        try {
            this.assertOpen();
        } catch (error) {
            return Promise.reject(normalizeError(error));
        }

        return runInEffectScope(
            this.lifetimeScope,
            Effect.tryPromise({
                try: (signal) => Promise.resolve(callback({ signal })),
                catch: normalizeError,
            }),
            [options?.signal]
        ).catch((error: unknown) => this.rethrowScopedError(error));
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.clearEventListeners();
        this.closePromise = Effect.runPromise(Scope.close(this.lifetimeScope, Exit.void));
        return this.closePromise;
    }

    protected invokeRequest(
        namespace: string,
        method: string,
        input: unknown,
        options: CoordinationCallOptions | undefined,
        context: InvocationContext
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new CoordinationClosedError());
        }
        return runInEffectScope(
            this.lifetimeScope,
            Effect.tryPromise({
                try: (signal) =>
                    this.core.invoke(namespace, method, input, {
                        inheritedSignal: signal,
                        senderId: this.nodeId,
                        path: context.path,
                    }),
                catch: normalizeError,
            }),
            [context.signal, options?.signal]
        ).catch((error: unknown) => this.rethrowScopedError(error));
    }

    private rethrowScopedError(error: unknown): never {
        if (this.closed) {
            throw new CoordinationClosedError();
        }
        throw normalizeError(error);
    }
}
