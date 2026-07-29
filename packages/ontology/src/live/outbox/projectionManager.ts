import { requestFingerprint } from "./repository.js";
import type { OntologyOutboxEntry } from "./types.js";

export interface OutboxProjection {
    settle(error?: Error): void;
}

interface DesiredProjection {
    entry: OntologyOutboxEntry;
    fingerprint: string;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function desiredProjections(entries: readonly OntologyOutboxEntry[]): DesiredProjection[] {
    return [...entries]
        .filter(
            (entry) =>
                entry.status !== "failed" ||
                entry.retryable
        )
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => ({
            entry,
            fingerprint: requestFingerprint(entry.request),
        }));
}

export class OutboxProjectionManager {
    private desired: DesiredProjection[] = [];
    private readonly projections = new Map<string, OutboxProjection>();
    private readonly installedFingerprints = new Map<string, string>();
    private readonly versions = new Map<string, number>();
    private tail = Promise.resolve();
    private closed = false;
    private disabledError: Error | undefined;

    constructor(
        private readonly project:
            | ((entry: OntologyOutboxEntry) => Promise<OutboxProjection | undefined>)
            | undefined
    ) {}

    get error(): Error | undefined {
        return this.disabledError;
    }

    restore(
        entries: readonly OntologyOutboxEntry[]
    ): Promise<void> {
        return this.schedule(() =>
            this.applyDesired(
                desiredProjections(entries)
            )
        );
    }

    reconcile(
        entries: readonly OntologyOutboxEntry[]
    ): Promise<void> {
        return this.schedule(() =>
            this.applyDesired(
                desiredProjections(entries)
            )
        );
    }

    ensure(entry: OntologyOutboxEntry): Promise<void> {
        return this.schedule(() => {
            const entries = this.desired
                .filter((candidate) => candidate.entry.id !== entry.id)
                .map((candidate) => candidate.entry);
            entries.push(entry);
            return this.applyDesired(
                desiredProjections(entries)
            );
        });
    }

    discard(id: string, error?: Error): Promise<void> {
        return this.schedule(() =>
            this.applyDesired(
                this.desired.filter((candidate) => candidate.entry.id !== id),
                (removed) =>
                    removed.entry.id === id ? error : new Error("Outbox optimistic projection replayed.")
            )
        );
    }

    close(): Promise<void> {
        if (this.closed) return Promise.resolve();
        this.closed = true;
        const error = new Error("Outbox disposed.");
        for (const candidate of this.desired) {
            this.invalidate(candidate.entry.id, error);
        }
        this.desired = [];
        return Promise.resolve();
    }

    private schedule(work: () => Promise<void>): Promise<void> {
        if (this.closed) return Promise.resolve();
        const scheduled = this.tail
            .catch(() => undefined)
            .then(async () => {
                if (!this.closed) await work();
            });
        this.tail = scheduled.catch(() => undefined);
        return scheduled;
    }

    private async applyDesired(
        next: DesiredProjection[],
        removalError: (removed: DesiredProjection) => Error | undefined = () =>
            new Error("Outbox optimistic projection replaced.")
    ): Promise<void> {
        if (this.disabledError) return;
        const divergence = this.firstDivergence(this.desired, next);
        if (divergence === -1) {
            for (const candidate of next) {
                if (this.installedFingerprints.get(candidate.entry.id) !== candidate.fingerprint) {
                    try {
                        await this.install(candidate);
                    } catch (error) {
                        this.disable(
                            normalizeError(error)
                        );
                        return;
                    }
                }
            }
            return;
        }

        for (let index = this.desired.length - 1; index >= divergence; index -= 1) {
            const removed = this.desired[index]!;
            this.invalidate(removed.entry.id, removalError(removed));
        }
        this.desired = next;

        for (let index = divergence; index < next.length; index += 1) {
            const candidate = next[index]!;
            try {
                await this.install(candidate);
            } catch (error) {
                this.disable(normalizeError(error));
                return;
            }
        }
    }

    private disable(error: Error): void {
        for (
            let index = this.desired.length - 1;
            index >= 0;
            index -= 1
        ) {
            this.invalidate(
                this.desired[index]!.entry.id,
                error
            );
        }
        this.desired = [];
        this.disabledError = error;
    }

    private firstDivergence(
        current: readonly DesiredProjection[],
        next: readonly DesiredProjection[]
    ): number {
        const length = Math.max(current.length, next.length);
        for (let index = 0; index < length; index += 1) {
            const previous = current[index];
            const candidate = next[index];
            if (
                previous?.entry.id !== candidate?.entry.id ||
                previous?.fingerprint !== candidate?.fingerprint
            ) {
                return index;
            }
        }
        return -1;
    }

    private async install(candidate: DesiredProjection): Promise<void> {
        if (this.installedFingerprints.get(candidate.entry.id) === candidate.fingerprint) {
            return;
        }

        this.invalidate(candidate.entry.id, new Error("Outbox optimistic projection replaced."));
        const version = this.versions.get(candidate.entry.id) ?? 0;
        const projection = await this.project?.(candidate.entry);
        if (this.closed || this.versions.get(candidate.entry.id) !== version) {
            this.settle(
                projection,
                new Error(this.closed ? "Outbox disposed." : "Outbox projection became stale.")
            );
            return;
        }

        if (projection) {
            this.projections.set(candidate.entry.id, projection);
        }
        this.installedFingerprints.set(candidate.entry.id, candidate.fingerprint);
    }

    private invalidate(id: string, error?: Error): void {
        this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
        this.settle(this.projections.get(id), error);
        this.projections.delete(id);
        this.installedFingerprints.delete(id);
    }

    private settle(projection: OutboxProjection | undefined, error?: Error): void {
        try {
            projection?.settle(error);
        } catch {
            // Projection teardown is isolated from outbox state.
        }
    }
}
