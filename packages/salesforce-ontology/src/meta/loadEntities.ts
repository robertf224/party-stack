import type { SalesforceClient, SalesforceSObjectDescribe } from "@party-stack/salesforce-client";

export async function describeSObjects(
    client: SalesforceClient,
    names: readonly string[]
): Promise<SalesforceSObjectDescribe[]> {
    const describes = await Promise.all(
        [...new Set(names)].map(async (name) => {
            try {
                return await client.describeSObject(name);
            } catch {
                return undefined;
            }
        })
    );
    return describes.filter((describe): describe is SalesforceSObjectDescribe => Boolean(describe));
}
