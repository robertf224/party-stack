import { expect, test } from "vite-plus/test";
import { demandAttribution, transformDemandAttribution } from "./index.js";

test("instruments named query hooks and DOM ownership without changing query arguments", async () => {
    const source = `import { useLiveQuery as useRows } from '@tanstack/react-db';
      export function List({ collection }) {
        const result = useRows({ query: q => q.from({ collection }) });
        return <><section>{result.data.map(row => <span key={row.id}>{row.id}</span>)}</section></>;
      }`;
    const result = await transformDemandAttribution(source, "List.tsx");
    expect(result?.code).toContain('usePartyStackDemandOwner("List", "List.tsx:2")');
    expect(result?.code).toContain("usePartyStackDemandQuery(_demandOwner, useRows(");
    expect(result?.code.match(/data-ps-demand-owner=/g)).toHaveLength(2);
    expect(result?.map).toBeDefined();
    expect(await transformDemandAttribution(result!.code, "List.tsx")).toBeNull();
});

test("supports distinct component scopes and avoids custom hooks or shadowed imports", async () => {
    const result = await transformDemandAttribution(
        `import { useLiveQuery } from '@tanstack/react-db';
      const First = () => <div>{useLiveQuery({ query }).data.length}</div>;
      function Second() { const q = useLiveQuery({ query }); return <aside /> }
      function useCustom() { return useLiveQuery({ query }); }
      function Shadow(useLiveQuery) { return <div>{useLiveQuery()}</div> }`,
        "App.tsx"
    );
    expect(result?.code.match(/usePartyStackDemandQuery\(/g)).toHaveLength(2);
    expect(result?.code).toContain('"First"');
    expect(result?.code).toContain('"Second"');
    expect(result?.code).toContain("return useLiveQuery({");
    expect(demandAttribution().apply).toBe("serve");
});
