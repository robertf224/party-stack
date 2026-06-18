# @bobbyfidz/apollo

Utilities for interacting with Palantir's Apollo platform.

## Helm chart product releases

Use `createHelmChartProductRelease` for the newer Apollo product-release manifest flow when a release needs manifest extensions such as product dependencies or rollout settings.

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

The helper writes an Apollo product manifest and invokes the documented `apollo-cli product-release create` command. The Apollo docs currently document CLI creation, not a stable REST create endpoint; `searchProductReleases` uses the catalog API for read-side checks when a space ID is available.

If your Apollo Hub requires container image metadata, pass the images through `artifacts`. This helper does not render the Helm chart to auto-discover images the way `apollo-cli product-release helm-chart init` does.
