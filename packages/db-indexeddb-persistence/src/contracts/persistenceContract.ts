// Adapted from TanStack/db, MIT licensed; see contracts/NOTICE.md for source and changes.
import { IR } from "@tanstack/db";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistenceAdapter, PersistencePullSinceResult } from "@tanstack/db-sqlite-persistence-core";

type Todo = { id: string; title: string; createdAt: string; score: number };
export type ContractAdapter = PersistenceAdapter & { pullSince(collectionId: string, fromRowVersion: number): Promise<PersistencePullSinceResult> };
export interface ContractHarness { adapter: ContractAdapter; unserializable: unknown; cleanup(): void | Promise<void> }
export function runPersistenceContract(suiteName: string, factory: (options: { pullSinceReloadThreshold?: number }) => ContractHarness): void {
    const harnesses: ContractHarness[] = [];
    function registerContractHarness(options = {}) {
        const harness = factory(options);
        harnesses.push(harness);
        return harness;
    }
    afterEach(async () => {
        const results = await Promise.allSettled(harnesses.splice(0).map(async (harness) => { await harness.cleanup(); }));
        const errors = results.filter((result) => result.status === "rejected");
        if (errors.length) throw new AggregateError(errors.map((result) => new Error("Harness cleanup failed", { cause: result.reason as unknown })), "Contract harness cleanup failed");
    });
    describe(suiteName, () => {
    it(`supports pushdown operators with correctness-preserving fallback`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `todos`

      const rows: Array<Todo> = [
        {
          id: `1`,
          title: `Task Alpha`,
          createdAt: `2026-01-01T00:00:00.000Z`,
          score: 10,
        },
        {
          id: `2`,
          title: `Task Beta`,
          createdAt: `2026-01-02T00:00:00.000Z`,
          score: 20,
        },
        {
          id: `3`,
          title: `Other`,
          createdAt: `2026-01-03T00:00:00.000Z`,
          score: 15,
        },
        {
          id: `4`,
          title: `Task Gamma`,
          createdAt: `2026-01-04T00:00:00.000Z`,
          score: 25,
        },
      ]

      await adapter.applyCommittedTx(collectionId, {
        txId: `seed-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: rows.map((row) => ({
          type: `insert` as const,
          key: row.id,
          value: row,
        })),
      })

      const filtered = await adapter.loadSubset(collectionId, {
        where: new IR.Func(`and`, [
          new IR.Func(`or`, [
            new IR.Func(`like`, [
              new IR.PropRef([`title`]),
              new IR.Value(`%Task%`),
            ]),
            new IR.Func(`in`, [new IR.PropRef([`id`]), new IR.Value([`3`])]),
          ]),
          new IR.Func(`eq`, [
            new IR.Func(`date`, [new IR.PropRef([`createdAt`])]),
            new IR.Value(`2026-01-02`),
          ]),
        ]),
        orderBy: [
          {
            expression: new IR.PropRef([`score`]),
            compareOptions: {
              direction: `desc`,
              nulls: `last`,
            },
          },
        ],
      })

      expect(filtered).toEqual([
        {
          key: `2`,
          value: {
            id: `2`,
            title: `Task Beta`,
            createdAt: `2026-01-02T00:00:00.000Z`,
            score: 20,
          },
        },
      ])

      const withInEmpty = await adapter.loadSubset(collectionId, {
        where: new IR.Func(`in`, [
          new IR.PropRef([`id`]),
          new IR.Value([] as Array<string>),
        ]),
      })
      expect(withInEmpty).toEqual([])
    })

    it(`persists bigint/date values and evaluates typed predicates`, async () => {
      const { adapter } = registerContractHarness()
      const typedAdapter = adapter
      const collectionId = `typed-values`
      const firstBigInt = BigInt(`9007199254740992`)
      const secondBigInt = BigInt(`9007199254740997`)

      await typedAdapter.applyCommittedTx(collectionId, {
        txId: `seed-typed-values`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Alpha`,
              createdAt: new Date(`2026-01-02T00:00:00.000Z`),
              largeViewCount: firstBigInt,
            },
          },
          {
            type: `insert`,
            key: `2`,
            value: {
              id: `2`,
              title: `Beta`,
              createdAt: new Date(`2026-01-03T00:00:00.000Z`),
              largeViewCount: secondBigInt,
            },
          },
        ],
      })

      // Filter-only subset reads may legally be supersets; an indexed typed
      // predicate provides the exact candidate set exercised by this upstream case.
      await adapter.ensureIndex(collectionId, `bigint`, { expressionSql: [JSON.stringify(new IR.PropRef([`largeViewCount`]))] })
      await adapter.ensureIndex(collectionId, `date`, { expressionSql: [JSON.stringify(new IR.PropRef([`createdAt`]))] })

      const bigintRows = await typedAdapter.loadSubset(collectionId, {
        where: new IR.Func(`gt`, [
          new IR.PropRef([`largeViewCount`]),
          new IR.Value(BigInt(`9007199254740993`)),
        ]),
      })
      expect(bigintRows.map((row) => row.key)).toEqual([`2`])

      const dateRows = await typedAdapter.loadSubset(collectionId, {
        where: new IR.Func(`gt`, [
          new IR.PropRef([`createdAt`]),
          new IR.Value(new Date(`2026-01-02T12:00:00.000Z`)),
        ]),
      })
      expect(dateRows.map((row) => row.key)).toEqual([`2`])

      const restoredRows = await typedAdapter.loadSubset(collectionId, {
        where: new IR.Func(`eq`, [
          new IR.Func(`date`, [new IR.PropRef([`createdAt`])]),
          new IR.Value(`2026-01-02`),
        ]),
      })
      const firstRow = restoredRows[0]?.value
      expect(firstRow?.createdAt).toBeInstanceOf(Date)
      expect(firstRow?.largeViewCount).toBe(firstBigInt)
    })

    it(`applies transactions idempotently with row versions and tombstones`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `todos`

      await adapter.applyCommittedTx(collectionId, {
        txId: `tx-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Initial`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 10,
            },
          },
        ],
      })
      await adapter.applyCommittedTx(collectionId, {
        txId: `tx-1-replay`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Initial`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 10,
            },
          },
        ],
      })

      const replay = await adapter.pullSince(collectionId, 0)
      expect(replay.requiresFullReload).toBe(false)
      if (!replay.requiresFullReload) expect(replay.deltas).toHaveLength(1)

      await adapter.applyCommittedTx(collectionId, {
        txId: `tx-2`,
        term: 1,
        seq: 2,
        rowVersion: 2,
        mutations: [
          {
            type: `update`,
            key: `1`,
            value: {
              id: `1`,
              title: `Updated`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 11,
            },
          },
        ],
      })

      const updated = await adapter.loadSubset(collectionId, {
        where: new IR.Func(`eq`, [new IR.PropRef([`id`]), new IR.Value(`1`)]),
      })
      expect(updated).toEqual([
        {
          key: `1`,
          value: {
            id: `1`,
            title: `Updated`,
            createdAt: `2026-01-01T00:00:00.000Z`,
            score: 11,
          },
        },
      ])

      await adapter.applyCommittedTx(collectionId, {
        txId: `tx-3`,
        term: 1,
        seq: 3,
        rowVersion: 3,
        mutations: [
          {
            type: `delete`,
            key: `1`,
            value: {
              id: `1`,
              title: `Updated`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 11,
            },
          },
        ],
      })

      const remainingRows = await adapter.loadSubset(collectionId, {})
      expect(remainingRows).toEqual([])

      const deletion = await adapter.pullSince(collectionId, 2)
      expect(deletion).toMatchObject({ latestRowVersion: 3, requiresFullReload: false, changedKeys: [], deletedKeys: [`1`] })
    })

    it(`rolls back partially applied mutations when transaction fails`, async () => {
      const { adapter, unserializable } = registerContractHarness()
      const collectionId = `atomicity`

      await expect(
        adapter.applyCommittedTx(collectionId, {
          txId: `atomicity-1`,
          term: 1,
          seq: 1,
          rowVersion: 1,
          mutations: [
            {
              type: `insert`,
              key: `1`,
              value: {
                id: `1`,
                title: `First`,
                createdAt: `2026-01-01T00:00:00.000Z`,
                score: 1,
              },
            },
            {
              type: `insert`,
              key: `2`,
              value: {
                id: `2`,
                title: `Second`,
                createdAt: `2026-01-01T00:00:00.000Z`,
                score: 2,
                // Backend-specific invalid value must reject the entire transaction.
                unsafeDate: unserializable,
              } as unknown as Todo,
            },
          ],
        }),
      ).rejects.toThrow()

      const rows = await adapter.loadSubset(collectionId, {})
      expect(rows).toEqual([])

      expect(await adapter.getStreamPosition?.(collectionId)).toMatchObject({ latestRowVersion: 0, latestSeq: 0 })
    })

    it(`persists row metadata and collection metadata atomically`, async () => {
      const { adapter, unserializable } = registerContractHarness()
      const collectionId = `metadata-roundtrip`

      await adapter.applyCommittedTx(collectionId, {
        txId: `metadata-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Tracked`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
            metadata: {
              queryCollection: {
                owners: {
                  q1: true,
                },
              },
            },
            metadataChanged: true,
          },
        ],
        collectionMetadataMutations: [
          {
            type: `set`,
            key: `electric:resume`,
            value: {
              kind: `resume`,
              offset: `10_0`,
              handle: `handle-1`,
              shapeId: `shape-1`,
              updatedAt: 1,
            },
          },
        ],
      })

      const rows = await adapter.loadSubset(collectionId, {})
      expect(rows).toEqual([
        {
          key: `1`,
          value: {
            id: `1`,
            title: `Tracked`,
            createdAt: `2026-01-01T00:00:00.000Z`,
            score: 1,
          },
          metadata: {
            queryCollection: {
              owners: {
                q1: true,
              },
            },
          },
        },
      ])

      const collectionMetadata =
        await adapter.loadCollectionMetadata?.(collectionId)
      expect(collectionMetadata).toEqual([
        {
          key: `electric:resume`,
          value: {
            kind: `resume`,
            offset: `10_0`,
            handle: `handle-1`,
            shapeId: `shape-1`,
            updatedAt: 1,
          },
        },
      ])

      await expect(
        adapter.applyCommittedTx(collectionId, {
          txId: `metadata-2`,
          term: 1,
          seq: 2,
          rowVersion: 2,
          mutations: [
            {
              type: `insert`,
              key: `2`,
              value: {
                id: `2`,
                title: `Bad`,
                createdAt: `2026-01-01T00:00:00.000Z`,
                score: 2,
              },
            },
          ],
          collectionMetadataMutations: [
            {
              type: `set`,
              key: `broken`,
              value: {
                invalid: unserializable,
              },
            },
          ],
        }),
      ).rejects.toThrow()

      const rowsAfterFailure = await adapter.loadSubset(collectionId, {})
      expect(rowsAfterFailure).toEqual(rows)

      expect(await adapter.loadCollectionMetadata?.(collectionId)).toEqual(collectionMetadata)
      expect(await adapter.getStreamPosition?.(collectionId)).toMatchObject({ latestRowVersion: 1, latestSeq: 1 })
    })

    it(`persists truncate transactions while preserving explicit collection metadata`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `truncate-metadata-roundtrip`

      await adapter.applyCommittedTx(collectionId, {
        txId: `seed-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Before truncate`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
            metadata: {
              owner: `before`,
            },
            metadataChanged: true,
          },
        ],
        collectionMetadataMutations: [
          {
            type: `set`,
            key: `electric:resume`,
            value: {
              kind: `resume`,
              offset: `10_0`,
              handle: `handle-1`,
              shapeId: `shape-1`,
              updatedAt: 1,
            },
          },
        ],
      })

      await adapter.applyCommittedTx(collectionId, {
        txId: `truncate-2`,
        term: 1,
        seq: 2,
        rowVersion: 2,
        truncate: true,
        mutations: [
          {
            type: `insert`,
            key: `2`,
            value: {
              id: `2`,
              title: `After truncate`,
              createdAt: `2026-01-02T00:00:00.000Z`,
              score: 2,
            },
            metadata: {
              owner: `after`,
            },
            metadataChanged: true,
          },
        ],
        collectionMetadataMutations: [
          {
            type: `set`,
            key: `electric:resume`,
            value: {
              kind: `reset`,
              updatedAt: 2,
            },
          },
        ],
      })

      expect(await adapter.loadSubset(collectionId, {})).toEqual([
        {
          key: `2`,
          value: {
            id: `2`,
            title: `After truncate`,
            createdAt: `2026-01-02T00:00:00.000Z`,
            score: 2,
          },
          metadata: {
            owner: `after`,
          },
        },
      ])

      expect(await adapter.loadCollectionMetadata?.(collectionId)).toEqual([
        {
          key: `electric:resume`,
          value: {
            kind: `reset`,
            updatedAt: 2,
          },
        },
      ])
    })

    it(`returns pullSince deltas and requiresFullReload when threshold is exceeded`, async () => {
      const { adapter } = registerContractHarness({
        pullSinceReloadThreshold: 1,
      })
      const collectionId = `todos`

      await adapter.applyCommittedTx(collectionId, {
        txId: `seed-pull`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `One`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
          },
          {
            type: `insert`,
            key: `2`,
            value: {
              id: `2`,
              title: `Two`,
              createdAt: `2026-01-02T00:00:00.000Z`,
              score: 2,
            },
          },
        ],
      })
      await adapter.applyCommittedTx(collectionId, {
        txId: `seed-pull-2`,
        term: 1,
        seq: 2,
        rowVersion: 2,
        mutations: [
          {
            type: `delete`,
            key: `1`,
            value: {
              id: `1`,
              title: `One`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
          },
        ],
      })

      const delta = await adapter.pullSince(collectionId, 1)
      if (delta.requiresFullReload) {
        throw new Error(`Expected key-level delta, received full reload`)
      }
      expect(delta.changedKeys).toEqual([])
      expect(delta.deletedKeys).toEqual([`1`])
      expect(delta.deltas).toEqual([
        {
          txId: `seed-pull-2`,
          latestRowVersion: 2,
          changedRows: [],
          deletedKeys: [`1`],
          rowMetadataMutations: [],
          collectionMetadataMutations: [],
        },
      ])

      const fullReload = await adapter.pullSince(collectionId, 0)
      expect(fullReload.requiresFullReload).toBe(true)
    })

    it(`scans persisted rows with metadata and replays metadata-only deltas`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `scan-and-replay`

      await adapter.applyCommittedTx(collectionId, {
        txId: `scan-seed-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `Tracked`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
            metadata: {
              queryCollection: {
                owners: {
                  q1: true,
                },
              },
            },
            metadataChanged: true,
          },
        ],
      })

      const scannedRows = await adapter.scanRows?.(collectionId, {
        metadataOnly: true,
      })
      expect(scannedRows).toEqual([
        {
          key: `1`,
          value: {
            id: `1`,
            title: `Tracked`,
            createdAt: `2026-01-01T00:00:00.000Z`,
            score: 1,
          },
          metadata: {
            queryCollection: {
              owners: {
                q1: true,
              },
            },
          },
        },
      ])

      await adapter.applyCommittedTx(collectionId, {
        txId: `scan-seed-2`,
        term: 1,
        seq: 2,
        rowVersion: 2,
        mutations: [],
        rowMetadataMutations: [
          {
            type: `set`,
            key: `1`,
            value: {
              queryCollection: {
                owners: {
                  q2: true,
                },
              },
            },
          },
        ],
        collectionMetadataMutations: [
          {
            type: `set`,
            key: `electric:resume`,
            value: {
              kind: `reset`,
              updatedAt: 2,
            },
          },
        ],
      })

      const replayDelta = await adapter.pullSince(collectionId, 1)
      if (replayDelta.requiresFullReload) {
        throw new Error(`Expected replay delta, received full reload`)
      }

      expect(replayDelta.deltas).toEqual([
        {
          txId: `scan-seed-2`,
          latestRowVersion: 2,
          changedRows: [],
          deletedKeys: [],
          rowMetadataMutations: [
            {
              type: `set`,
              key: `1`,
              value: {
                queryCollection: {
                  owners: {
                    q2: true,
                  },
                },
              },
            },
          ],
          collectionMetadataMutations: [
            {
              type: `set`,
              key: `electric:resume`,
              value: {
                kind: `reset`,
                updatedAt: 2,
              },
            },
          ],
        },
      ])
    })

    it(`handles cursor whereCurrent/whereFrom requests`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `todos`

      await adapter.applyCommittedTx(collectionId, {
        txId: `seed-cursor`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: `a`,
            value: {
              id: `a`,
              title: `A`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 10,
            },
          },
          {
            type: `insert`,
            key: `b`,
            value: {
              id: `b`,
              title: `B`,
              createdAt: `2026-01-02T00:00:00.000Z`,
              score: 10,
            },
          },
          {
            type: `insert`,
            key: `c`,
            value: {
              id: `c`,
              title: `C`,
              createdAt: `2026-01-03T00:00:00.000Z`,
              score: 12,
            },
          },
          {
            type: `insert`,
            key: `d`,
            value: {
              id: `d`,
              title: `D`,
              createdAt: `2026-01-04T00:00:00.000Z`,
              score: 13,
            },
          },
        ],
      })

      const rows = await adapter.loadSubset(collectionId, {
        orderBy: [
          {
            expression: new IR.PropRef([`score`]),
            compareOptions: {
              direction: `asc`,
              nulls: `last`,
            },
          },
        ],
        limit: 1,
        cursor: {
          whereCurrent: new IR.Func(`eq`, [
            new IR.PropRef([`score`]),
            new IR.Value(10),
          ]),
          whereFrom: new IR.Func(`gt`, [
            new IR.PropRef([`score`]),
            new IR.Value(10),
          ]),
        },
      })

      expect(rows.map((row) => row.key)).toEqual([`a`, `b`, `c`])
    })

    it.each([
      {
        case: `ascending`,
        direction: `asc` as const,
        compare: (left: string, right: string) => right.localeCompare(left),
        expected: [`zeta`, `middle`, `alpha`],
      },
      {
        case: `descending`,
        direction: `desc` as const,
        compare: (left: string, right: string) => right.localeCompare(left),
        expected: [`alpha`, `middle`, `zeta`],
      },
      {
        case: `comparator-equal key order`,
        direction: `asc` as const,
        compare: () => 0,
        expected: [`zeta`, `alpha`, `middle`],
      },
    ])(
      `applies custom string collation during persisted subset ordering ($case)`,
      async ({ case: caseName, direction, compare, expected }) => {
        const { adapter } = registerContractHarness()
        const collectionId = `custom-collation-order-${caseName}`

        await adapter.applyCommittedTx(collectionId, {
          txId: `seed-custom-collation`,
          term: 1,
          seq: 1,
          rowVersion: 1,
          mutations: [`zeta`, `alpha`, `middle`].map((title, index) => ({
            type: `insert` as const,
            key: String(index),
            value: { id: String(index), title, createdAt: ``, score: index },
          })),
        })

        const rows = await adapter.loadSubset(collectionId, {
          orderBy: [
            {
              expression: new IR.PropRef([`title`]),
              compareOptions: {
                direction,
                nulls: `last`,
                stringSort: `custom`,
                compare,
              },
            },
          ],
        })

        expect(rows.map(({ value }) => value.title)).toEqual(expected)
      },
    )

    it(`keeps numeric and string keys distinct in storage`, async () => {
      const { adapter } = registerContractHarness()
      const collectionId = `mixed-keys`

      await adapter.applyCommittedTx(collectionId, {
        txId: `mixed-1`,
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: [
          {
            type: `insert`,
            key: 1,
            value: {
              id: 1,
              title: `Numeric`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 1,
            },
          },
          {
            type: `insert`,
            key: `1`,
            value: {
              id: `1`,
              title: `String`,
              createdAt: `2026-01-01T00:00:00.000Z`,
              score: 2,
            },
          },
        ],
      })

      const rows = await adapter.loadSubset(collectionId, {})
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.key === 1)).toBe(true)
      expect(rows.some((row) => row.key === `1`)).toBe(true)
    })

    });
}
