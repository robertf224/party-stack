import {
    run,
    suspend,
    until,
    useAbortSignal,
    useScope,
    type Operation,
    type Scope,
    type Task,
} from "effection";
import {
    BaseCoordination,
    type InvocationContext,
} from "./base.js";
import {
    CoordinationClosedError,
    type CoordinationCallOptions,
    type CoordinationHost,
    type CoordinationOptions,
    type CoordinationService,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
} from "./contracts.js";
import { runInScope } from "./effection/runInScope.js";
import { HostCore } from "./host-core.js";
import {
    deferred,
    normalizeError,
    randomId,
} from "./internal.js";

export class SingleProcessCoordination
    extends BaseCoordination
    implements CoordinationHost
{
    readonly role = "host" as const;
    readonly isLeader = true;
    readonly scope: string;

    private readonly nodeId = randomId();
    private readonly core: HostCore;
    private readonly rootScope = deferred<Scope>();
    private readonly task: Task<void>;
    private closePromise?: Promise<void>;

    constructor(options: CoordinationOptions) {
        super();
        this.scope = options.scope;
        this.core = new HostCore({
            contextClient: (path, signal) =>
                this.createContextClient({ path, signal }),
            publishEvent: (namespace, event, payload) =>
                this.emitEvent(namespace, event, payload),
        });
        this.task = run(() => this.useLifetime());
        void this.task.catch((error: unknown) => {
            this.rootScope.reject(
                normalizeError(error)
            );
        });
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        this.assertOpen();
        return this.core.serve(namespace, handlers);
    }

    runAsLeader<Result>(
        callback: (context: {
            signal: AbortSignal;
        }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        try {
            this.assertOpen();
        } catch (error) {
            return Promise.reject(normalizeError(error));
        }

        return this.rootScope.promise
            .then((scope) =>
                runInScope(
                    scope,
                    function* () {
                        const signal =
                            yield* useAbortSignal();
                        return yield* until(
                            Promise.resolve(
                                callback({ signal })
                            )
                        );
                    },
                    [options?.signal]
                )
            )
            .catch((error: unknown) =>
                this.rethrowScopedError(error)
            );
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.clearEventListeners();
        this.closePromise = this.task
            .halt()
            .then(() => undefined);
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
        return this.rootScope.promise
            .then((scope) =>
                runInScope(
                    scope,
                    () =>
                        this.invokeOperation(
                            namespace,
                            method,
                            input,
                            context.path
                        ),
                    [
                        context.signal,
                        options?.signal,
                    ]
                )
            )
            .catch((error: unknown) =>
                this.rethrowScopedError(error)
            );
    }

    private *invokeOperation(
        namespace: string,
        method: string,
        input: unknown,
        path: readonly string[]
    ): Operation<unknown> {
        const signal = yield* useAbortSignal();
        return yield* until(
            this.core.invoke(
                namespace,
                method,
                input,
                {
                    inheritedSignal: signal,
                    senderId: this.nodeId,
                    path,
                }
            )
        );
    }

    private *useLifetime(): Operation<void> {
        const scope = yield* useScope();
        this.rootScope.resolve(scope);
        try {
            yield* suspend();
        } finally {
            yield* until(this.core.close());
            this.clearEventListeners();
            this.rootScope.reject(
                new CoordinationClosedError()
            );
        }
    }

    private rethrowScopedError(
        error: unknown
    ): never {
        if (this.closed) {
            throw new CoordinationClosedError();
        }
        throw normalizeError(error);
    }
}
