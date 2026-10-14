import { describe, expect, it, vi } from "vite-plus/test";
import { objectCollectionOptions } from "./objectCollectionOptions.js";
import type { LoadSubsetOptions } from "@tanstack/db";

describe("Salesforce object collection invalidation", () => {
    it("stages targeted reconciliation without waiting on its blocked sync receipt", async () => {
        const begin = vi.fn();
        const commit = vi.fn(() => new Promise<void>(() => undefined));
        const options = objectCollectionOptions({
            client: {
                query: vi
                    .fn()
                    .mockResolvedValue({
                        done: true,
                        records: [{ Id: "001", Name: "Confirmed" }],
                        totalSize: 1,
                    }),
            } as never,
            objectType: "Account",
            primaryKeyProperty: "Id",
            selectedProperties: ["Id", "Name"],
        });
        options.sync.sync({
            collection: { has: vi.fn(() => false), get: vi.fn() },
            begin,
            write: vi.fn(),
            commit,
            markError: vi.fn(),
            markReady: vi.fn(),
        } as never);

        await options.utils.refreshByKey("001");

        expect(begin).toHaveBeenCalledWith();
        expect(commit).toHaveBeenCalledOnce();
    });

    it("re-runs and awaits active subset loads", async () => {
        let resolveReload!: (value: {
            done: true;
            records: Array<Record<string, unknown>>;
            totalSize: number;
        }) => void;
        const query = vi
            .fn()
            .mockResolvedValueOnce({ done: true, records: [{ Id: "001", Name: "Before" }], totalSize: 1 })
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveReload = resolve;
                })
            );
        const options = objectCollectionOptions({
            client: { query } as never,
            objectType: "Account",
            primaryKeyProperty: "Id",
            selectedProperties: ["Id", "Name"],
        });
        const rows = new Map<string | number, Record<string, unknown>>();
        const commit = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockReturnValueOnce(new Promise<void>(() => undefined));
        const sync = options.sync.sync({
            collection: {
                has: (key: string | number) => rows.has(key),
                get: (key: string | number) => rows.get(key),
            },
            begin: vi.fn(),
            write: (message: { type: string; key?: string | number; value?: Record<string, unknown> }) => {
                if (message.type === "delete") {
                    rows.delete(message.key!);
                } else {
                    rows.set(message.value!.Id as string, message.value!);
                }
            },
            commit,
            markReady: vi.fn(),
        } as never);
        const subset = {} as LoadSubsetOptions;
        if (!sync || typeof sync === "function" || !("loadSubset" in sync)) {
            throw new Error("Expected subset sync controls.");
        }

        await sync.loadSubset?.(subset);
        expect(rows.get("001")?.Name).toBe("Before");

        let completed = false;
        const invalidation = options.utils.invalidate().then(() => {
            completed = true;
        });
        await Promise.resolve();
        expect(completed).toBe(false);

        resolveReload({ done: true, records: [{ Id: "001", Name: "After" }], totalSize: 1 });
        await invalidation;

        expect(query).toHaveBeenCalledTimes(2);
        expect(rows.get("001")?.Name).toBe("After");
        expect(commit).toHaveBeenCalledTimes(2);
    });

    it("restores and advances the CDC replay ID in collection metadata", async () => {
        const metadata = new Map<string, unknown>([["salesforce.cdc.Account.replayId", 41]]);
        let listener:
            | ((event: {
                  event: { replayId: number };
                  payload: { ChangeEventHeader: { changeType: "DELETE"; recordIds: string[] } };
              }) => void)
            | undefined;
        const subscribeToChangeEvents = vi.fn((...args: [string, typeof listener]) => {
            listener = args[1];
            return Promise.resolve({ channel: "/data/AccountChangeEvent", unsubscribe: vi.fn() });
        });
        const commit = vi.fn().mockResolvedValue(undefined);
        const options = objectCollectionOptions({
            client: { query: vi.fn() } as never,
            objectType: "Account",
            primaryKeyProperty: "Id",
            selectedProperties: ["Id"],
            subscribeToChangeEvents: subscribeToChangeEvents as never,
        });
        options.sync.sync({
            collection: { has: vi.fn(() => false), get: vi.fn() },
            begin: vi.fn(),
            write: vi.fn(),
            commit,
            markError: vi.fn(),
            markReady: vi.fn(),
            metadata: { collection: metadata },
        } as never);

        await vi.waitFor(() => {
            expect(subscribeToChangeEvents).toHaveBeenCalledWith("Account", expect.any(Function), {
                replayId: 41,
            });
        });
        listener?.({
            event: { replayId: 42 },
            payload: { ChangeEventHeader: { changeType: "DELETE", recordIds: ["001"] } },
        });
        await vi.waitFor(() => {
            expect(metadata.get("salesforce.cdc.Account.replayId")).toBe(42);
        });
        expect(commit).toHaveBeenCalled();
    });
});
