# salesforce-client

Authenticated Salesforce client for Party Stack adapters, backed by [`@jsforce/jsforce-node`](https://github.com/jsforce/jsforce).

Describe/query return jsforce types (`DescribeSObjectResult`, `QueryResult`, `Field`, …). Flow invocable action helpers use hand-typed REST shapes because jsforce has no first-class Actions API.

```ts
import { createSalesforceClient } from "@party-stack/salesforce-client";
import type { DescribeSObjectResult, QueryResult } from "@party-stack/salesforce-client";

const client = createSalesforceClient({
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL!,
    apiVersion: "61.0",
    tokenProvider: async () => process.env.SALESFORCE_ACCESS_TOKEN!,
});

const accounts: QueryResult = await client.query("SELECT Id, Name FROM Account LIMIT 10");
const accountDescribe: DescribeSObjectResult = await client.describeSObject("Account");
```

The client does not own OAuth flows. Callers supply a `tokenProvider` and an explicit API version.

Optional `fetch` replaces jsforce's default undici transport (useful in tests).
