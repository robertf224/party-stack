import { describe, expect, it } from "vitest";
import { createHelmChartProductManifest, serializeHelmChartProductManifest } from "./Apollo.js";

describe("createHelmChartProductManifest", () => {
    it("builds a helm chart product release manifest with Apollo extensions", () => {
        expect(
            createHelmChartProductManifest({
                mavenCoordinate: "com.valinor-enterprises.streamline:streamline-studio:2026.22.2",
                helmRepositoryUrl: "oci://ghcr.io/valinor-enterprises/streamline-studio-chart",
                helmChartName: "oci://ghcr.io/valinor-enterprises/streamline-studio-chart",
                helmChartVersion: "2026.22.2-031979fc",
                artifacts: [
                    {
                        type: "oci",
                        uri: "ghcr.io/valinor-enterprises/streamline-studio:2026.22.2-031979fc",
                    },
                ],
                productDependencies: [
                    {
                        productGroup: "com.valinor-enterprises.streamline",
                        productName: "streamline-ontology-install",
                        minimumVersion: "0.122.0",
                        maximumVersion: "0.122.0",
                        optional: false,
                    },
                ],
                rolloutStrategy: "manageRollout",
                resourceReadinessTimeout: "1h",
            })
        ).toEqual({
            "manifest-version": "1.0",
            "product-group": "com.valinor-enterprises.streamline",
            "product-name": "streamline-studio",
            "product-version": "2026.22.2",
            "product-type": "helm-chart.v1",
            extensions: {
                "helm-chart": {
                    "helm-chart-name": "oci://ghcr.io/valinor-enterprises/streamline-studio-chart",
                    "helm-chart-version": "2026.22.2-031979fc",
                    "helm-repository-url": "oci://ghcr.io/valinor-enterprises/streamline-studio-chart",
                },
                artifacts: [
                    {
                        type: "oci",
                        uri: "ghcr.io/valinor-enterprises/streamline-studio:2026.22.2-031979fc",
                    },
                ],
                "product-dependencies": [
                    {
                        "product-group": "com.valinor-enterprises.streamline",
                        "product-name": "streamline-ontology-install",
                        "minimum-version": "0.122.0",
                        "maximum-version": "0.122.0",
                        optional: false,
                    },
                ],
                "rollout-strategy": "manageRollout",
                "resource-readiness-timeout": "1h",
            },
        });
    });

    it("serializes the manifest as YAML for Apollo GraphQL", () => {
        const manifest = createHelmChartProductManifest({
            mavenCoordinate: "com.example:my-product:1.2.3",
            helmRepositoryUrl: "oci://ghcr.io/example/my-product-chart",
            helmChartName: "oci://ghcr.io/example/my-product-chart",
            helmChartVersion: "1.2.3",
            rolloutStrategy: "manageRollout",
        });

        expect(serializeHelmChartProductManifest(manifest)).toContain("product-type: helm-chart.v1");
        expect(serializeHelmChartProductManifest(manifest)).toContain("rollout-strategy: manageRollout");
    });
});
