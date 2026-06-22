# @bobbyfidz/apollo

Utilities for interacting with Palantir's Apollo platform.

## Helm chart product releases

Use `createHelmChartProductRelease` for the Apollo product-release manifest flow when a release needs manifest extensions such as product dependencies or rollout settings.

```ts
import { createHelmChartProductRelease } from "@bobbyfidz/apollo";

await createHelmChartProductRelease({
    apolloUrl: "https://example.palantircloud.com",
    auth: {
        type: "service-user",
        clientId: process.env.APOLLO_CLIENT_ID!,
        clientSecret: process.env.APOLLO_CLIENT_SECRET!,
    },
    mavenCoordinate: "com.example:my-product:1.2.3",
    helmRepositoryUrl: "oci://ghcr.io/example/my-product-chart",
    helmChartName: "oci://ghcr.io/example/my-product-chart",
    helmChartVersion: "1.2.3",
    productDependencies: [
        {
            productGroup: "com.example",
            productName: "my-dependency",
            minimumVersion: "1.2.3",
            maximumVersion: "1.2.3",
            optional: false,
        },
    ],
    rolloutStrategy: "manageRollout",
    resourceReadinessTimeout: "1h",
});
```

The helper writes an Apollo product manifest and publishes it through the `createProductReleaseFromManifestV2` GraphQL mutation. By default it posts to `/graphql-gateway/api/graphql` on `apolloUrl`; pass `graphqlUrl` or `graphqlPath` if a Hub exposes GraphQL elsewhere.

If your Apollo Hub requires container image metadata, pass the images through `artifacts`. This helper does not render the Helm chart to auto-discover images the way `apollo-cli product-release helm-chart init` does.
