import { execFile } from "child_process";
import { chmod, mkdir, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { BinaryDownload } from "@bobbyfidz/binaries";
import { invariant } from "@bobbyfidz/panic";
import { Pathnames, Urls } from "@bobbyfidz/urls";

const execFileAsync = promisify(execFile);

const BINARY_NAME = "apollo-cli";
const VERSION = "0.538.0";

export type ApolloAuth =
    | {
          type: "static";
          token: string;
      }
    | {
          type: "service-user";
          clientId: string;
          clientSecret: string;
      };

export type RolloutStrategy = "manageRollout" | "applyChangesNoWait";

export interface OciArtifact {
    type: "oci";
    uri: string;
}

export interface ProductDependency {
    productGroup: string;
    productName: string;
    minimumVersion: string;
    maximumVersion: string;
    recommendedVersion?: string;
    optional?: boolean;
}

export interface HelmChartProductManifest {
    "manifest-version": "1.0";
    "product-group": string;
    "product-name": string;
    "product-version": string;
    "product-type": "helm-chart.v1";
    extensions: {
        "helm-chart": {
            "helm-chart-name": string;
            "helm-chart-version": string;
            "helm-repository-url": string;
        };
        artifacts?: OciArtifact[];
        "product-dependencies"?: Array<{
            "product-group": string;
            "product-name": string;
            "minimum-version": string;
            "maximum-version": string;
            "recommended-version"?: string;
            optional?: boolean;
        }>;
        "rollout-strategy"?: RolloutStrategy;
        "resource-readiness-timeout"?: string;
        "image-pre-pull-config"?: {
            timeout: string;
        };
    } & Record<string, unknown>;
}

export interface CreateHelmChartProductManifestOptions {
    mavenCoordinate: string;
    helmRepositoryUrl: string;
    helmChartName: string;
    helmChartVersion: string;
    artifacts?: OciArtifact[];
    productDependencies?: ProductDependency[];
    rolloutStrategy?: RolloutStrategy;
    resourceReadinessTimeout?: string;
    imagePrePullConfigTimeout?: string;
    extensions?: Record<string, unknown>;
}

export async function getAccessToken(opts: { apolloUrl: string; auth: ApolloAuth }): Promise<string> {
    if (opts.auth.type === "static") {
        return opts.auth.token;
    }

    const response = await fetch(
        Urls.extend(opts.apolloUrl, {
            pathname: "/multipass/api/oauth2/token",
        }),
        {
            method: "POST",
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: opts.auth.clientId,
                client_secret: opts.auth.clientSecret,
            }),
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to get Apollo token: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token?: string };
    invariant(data.access_token, "Failed to get Apollo token.");
    return data.access_token;
}

function getAuthFromLegacyOpts(opts: { clientId: string; clientSecret: string }): ApolloAuth {
    return {
        type: "service-user",
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
    };
}

export async function ensureBinary(opts: {
    apolloUrl: string;
    clientId: string;
    clientSecret: string;
}): Promise<string>;

export async function ensureBinary(opts: {
    apolloUrl: string;
    auth: ApolloAuth;
}): Promise<string>;

export async function ensureBinary(
    opts:
        | {
              apolloUrl: string;
              clientId: string;
              clientSecret: string;
          }
        | {
              apolloUrl: string;
              auth: ApolloAuth;
          }
): Promise<string> {
    const auth = "auth" in opts ? opts.auth : getAuthFromLegacyOpts(opts);
    const token = await getAccessToken({ apolloUrl: opts.apolloUrl, auth });

    const binaryPath = await BinaryDownload.ensure(
        BINARY_NAME,
        VERSION,
        (binaryTarget) => {
            let distribution: string;
            switch (binaryTarget.platform) {
                case "darwin":
                    distribution = "macos";
                    break;
                case "linux":
                    invariant(binaryTarget.arch === "x64", "Apollo CLI is only supported on amd64.");
                    distribution = "linux-amd64";
                    break;
                case "windows":
                    invariant(binaryTarget.arch === "x64", "Apollo CLI is only supported on amd64.");
                    distribution = "windows-amd64";
                    break;
            }
            return {
                url: Urls.extend(opts.apolloUrl, {
                    // TODO: figure out how to pin version.
                    pathname: Pathnames.join("assets/dyn/apollo-cli/bin", distribution, "apollo-cli"),
                }).toString(),
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            };
        },
        path.join(import.meta.dirname, "..", "node_modules", ".cache", "apollo")
    );

    await chmod(binaryPath, 0o755);

    return binaryPath;
}

function redact(value: string | undefined, message: string): string {
    return value === undefined ? message : message.split(value).join("[REDACTED]");
}

function getAuthSecret(auth: ApolloAuth): string {
    return auth.type === "static" ? auth.token : auth.clientSecret;
}

function getApolloAuthArgs(auth: ApolloAuth): string[] {
    return auth.type === "static"
        ? ["--apollo-token-provider", "static", "--apollo-token", auth.token]
        : [
              "--apollo-token-provider",
              "service-user",
              "--apollo-client-id",
              auth.clientId,
              "--apollo-client-secret",
              auth.clientSecret,
          ];
}

async function executeApolloCli(opts: {
    apolloUrl: string;
    auth: ApolloAuth;
    args: string[];
    cwd?: string;
    secrets?: string[];
}): Promise<{ stdout: string; stderr: string }> {
    const cliPath = await ensureBinary({
        apolloUrl: opts.apolloUrl,
        auth: opts.auth,
    });

    try {
        return await execFileAsync(cliPath, opts.args, { cwd: opts.cwd, encoding: "utf8" });
    } catch (error) {
        if (!(error instanceof Error)) {
            throw error;
        }

        const redactedMessage = [getAuthSecret(opts.auth), ...(opts.secrets ?? [])].reduce(
            (message, secret) => redact(secret, message),
            error.message
        );
        throw new Error(redactedMessage);
    }
}

function parseMavenCoordinate(mavenCoordinate: string): {
    productGroup: string;
    productName: string;
    productVersion: string;
} {
    const [productGroup, productName, productVersion, ...rest] = mavenCoordinate.split(":");
    invariant(productGroup !== undefined && productGroup.length > 0, `Invalid Maven coordinate: ${mavenCoordinate}`);
    invariant(productName !== undefined && productName.length > 0, `Invalid Maven coordinate: ${mavenCoordinate}`);
    invariant(productVersion !== undefined && productVersion.length > 0, `Invalid Maven coordinate: ${mavenCoordinate}`);
    invariant(rest.length === 0, `Invalid Maven coordinate: ${mavenCoordinate}`);

    return { productGroup, productName, productVersion };
}

export function createHelmChartProductManifest(opts: CreateHelmChartProductManifestOptions): HelmChartProductManifest {
    const { productGroup, productName, productVersion } = parseMavenCoordinate(opts.mavenCoordinate);
    const extensions: HelmChartProductManifest["extensions"] = {
        ...(opts.extensions ?? {}),
        "helm-chart": {
            "helm-chart-name": opts.helmChartName,
            "helm-chart-version": opts.helmChartVersion,
            "helm-repository-url": opts.helmRepositoryUrl,
        },
    };

    if (opts.artifacts !== undefined) {
        extensions.artifacts = opts.artifacts;
    }

    if (opts.productDependencies !== undefined) {
        extensions["product-dependencies"] = opts.productDependencies.map((dependency) => ({
            "product-group": dependency.productGroup,
            "product-name": dependency.productName,
            "minimum-version": dependency.minimumVersion,
            "maximum-version": dependency.maximumVersion,
            ...(dependency.recommendedVersion === undefined
                ? {}
                : {
                      "recommended-version": dependency.recommendedVersion,
                  }),
            ...(dependency.optional === undefined ? {} : { optional: dependency.optional }),
        }));
    }

    if (opts.rolloutStrategy !== undefined) {
        extensions["rollout-strategy"] = opts.rolloutStrategy;
    }

    if (opts.resourceReadinessTimeout !== undefined) {
        extensions["resource-readiness-timeout"] = opts.resourceReadinessTimeout;
    }

    if (opts.imagePrePullConfigTimeout !== undefined) {
        extensions["image-pre-pull-config"] = {
            timeout: opts.imagePrePullConfigTimeout,
        };
    }

    return {
        "manifest-version": "1.0",
        "product-group": productGroup,
        "product-name": productName,
        "product-version": productVersion,
        "product-type": "helm-chart.v1",
        extensions,
    };
}

export async function writeHelmChartProductManifest(
    manifest: HelmChartProductManifest,
    manifestPath: string
): Promise<void> {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function publishHelmChart(opts: {
    apolloUrl: string;
    clientId: string;
    clientSecret: string;
    helmRepositoryUrl: string;
    helmChartName: string;
    helmChartVersion: string;
    helmUsername: string;
    helmPassword: string;
    mavenCoordinate: string;
}) {
    await executeApolloCli({
        apolloUrl: opts.apolloUrl,
        auth: getAuthFromLegacyOpts(opts),
        args: [
            "publish",
            "helm-chart",
            "--apollo-url",
            opts.apolloUrl,
            ...getApolloAuthArgs(getAuthFromLegacyOpts(opts)),
            "--helm-repository-url",
            opts.helmRepositoryUrl,
            "--helm-chart-name",
            opts.helmChartName,
            "--helm-chart-version",
            opts.helmChartVersion,
            "--helm-username",
            opts.helmUsername,
            "--helm-password",
            opts.helmPassword,
            "--maven-coordinate",
            opts.mavenCoordinate,
        ],
        secrets: [opts.helmPassword],
    });
}

export async function createHelmChartProductRelease(opts: CreateHelmChartProductManifestOptions & {
    apolloUrl: string;
    auth: ApolloAuth;
    outputDir?: string;
    cwd?: string;
    spaceId?: string;
}): Promise<{ manifest: HelmChartProductManifest; manifestPath: string }> {
    const manifest = createHelmChartProductManifest(opts);
    const outputDir = opts.outputDir ?? path.join(process.cwd(), ".apollo-product-release", manifest["product-version"]);
    const manifestPath = path.join(outputDir, "manifest.yml");

    await writeHelmChartProductManifest(manifest, manifestPath);
    await executeApolloCli({
        apolloUrl: opts.apolloUrl,
        auth: opts.auth,
        args: [
            "product-release",
            "create",
            "--apollo-url",
            opts.apolloUrl,
            ...getApolloAuthArgs(opts.auth),
            ...(opts.spaceId === undefined ? [] : ["--space-id", opts.spaceId]),
            "--manifest",
            manifestPath,
        ],
        cwd: opts.cwd,
    });

    return { manifest, manifestPath };
}

export async function searchProductReleases(opts: {
    apolloUrl: string;
    auth: ApolloAuth;
    spaceId: string;
    productId: string;
    inclusionCriteria?: unknown[];
    exclusionCriteria?: unknown[];
    pageSize?: number;
}): Promise<unknown> {
    const token = await getAccessToken({ apolloUrl: opts.apolloUrl, auth: opts.auth });
    const response = await fetch(
        Urls.extend(opts.apolloUrl, {
            pathname: Pathnames.join("apollo-catalog/api/spaces", opts.spaceId, "product-releases/search"),
        }),
        {
            method: "POST",
            body: JSON.stringify({
                productId: opts.productId,
                inclusionCriteria: opts.inclusionCriteria ?? [],
                exclusionCriteria: opts.exclusionCriteria ?? [],
                pageSize: opts.pageSize ?? 50,
            }),
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to search Apollo product releases: ${response.status} ${response.statusText}`);
    }

    return await response.json();
}
