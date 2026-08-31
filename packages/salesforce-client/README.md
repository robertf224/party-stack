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

## Real-org smoke test

Create a local External Client App in Salesforce Setup with:

- OAuth enabled
- Callback URL: `http://localhost:1717/oauth/callback`
- Scopes: API access, refresh token/offline access, and OpenID
- PKCE required
- Consumer secret optional (this command is a public client)

Then copy the example environment file and fill in the External Client App consumer key and
your org's My Domain URL:

```sh
cp packages/salesforce-client/.env.example packages/salesforce-client/.env
pnpm --filter @party-stack/salesforce-client smoke
```

The command opens Salesforce login in a browser and proves:

1. Authorization Code + PKCE login and secure session restoration work.
2. Global and `Task` describe calls succeed.
3. A real SOQL query against `Task` succeeds.
4. The Flow Actions endpoint is reachable, when the user has access.

The local `.env` and OAuth tokens are not committed. Tokens are persisted through the Node
runtime's secret store.

## Local demo dashboard

After the smoke test succeeds, launch the dashboard:

```sh
pnpm --filter @party-stack/salesforce-client demo
```

The command delegates to `apps/salesforce-task-manager`, opens the generated ontology through a
Salesforce backend installation, and serves `http://localhost:4173`. Dashboard reads use the
runtime `Task` and `User` collections; create, edit, delete, and drag operations use generated
ontology actions. Access tokens remain in the local process.

For changes made outside the dashboard to appear automatically, enable `Task` in Salesforce
**Setup → Change Data Capture**, then restart the demo. The local server subscribes to
`/data/TaskChangeEvent` through jsforce and forwards notifications to the browser with
Server-Sent Events. If CDC is unavailable, the dashboard remains usable with manual refresh.
