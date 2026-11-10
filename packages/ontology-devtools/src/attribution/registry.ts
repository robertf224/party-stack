export interface DemandOwner {
    readonly id: string;
    readonly name: string;
    readonly source: string;
}
export interface QueryConsumer {
    readonly owner: DemandOwner;
    readonly collection: object;
}
const consumers = new Set<QueryConsumer>();
const listeners = new Set<() => void>();
let revision = 0;
const changed = () => {
    revision++;
    for (const listener of listeners) listener();
};
export function registerQueryConsumer(owner: DemandOwner, collection: object) {
    const consumer = { owner, collection };
    consumers.add(consumer);
    changed();
    return () => {
        if (consumers.delete(consumer)) changed();
    };
}
export const queryConsumers = () => [...consumers];
export const attributionRevision = () => revision;
export function subscribeAttribution(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
