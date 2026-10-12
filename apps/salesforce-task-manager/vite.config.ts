import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { loadEnv, defineConfig, type Plugin } from "vite-plus";

function salesforceDevSessionPlugin(env: Record<string, string>): Plugin {
    return {
        name: "salesforce-dev-session",
        configureServer(server) {
            server.middlewares.use("/__salesforce/dev-session", async (request, response) => {
                if (request.method !== "POST") {
                    response.statusCode = 405;
                    response.end();
                    return;
                }
                const clientId = env.SALESFORCE_CLIENT_ID;
                const clientSecret = env.SALESFORCE_CLIENT_SECRET;
                const instanceUrl = env.SALESFORCE_INSTANCE_URL;
                const loginUrl = env.SALESFORCE_LOGIN_URL ?? instanceUrl;
                if (!clientId || !clientSecret || !instanceUrl || !loginUrl) {
                    response.statusCode = 404;
                    response.end();
                    return;
                }
                try {
                    const tokenResponse = await fetch(
                        `${loginUrl.replace(/\/+$/, "")}/services/oauth2/token`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/x-www-form-urlencoded",
                            },
                            body: new URLSearchParams({
                                grant_type: "client_credentials",
                                client_id: clientId,
                                client_secret: clientSecret,
                            }),
                        }
                    );
                    const token = (await tokenResponse.json()) as {
                        access_token?: unknown;
                    };
                    if (!tokenResponse.ok || typeof token.access_token !== "string") {
                        throw new Error(`Salesforce token endpoint returned ${tokenResponse.status}.`);
                    }
                    const userResponse = await fetch(
                        `${loginUrl.replace(/\/+$/, "")}/services/oauth2/userinfo`,
                        {
                            headers: {
                                Authorization: `Bearer ${token.access_token}`,
                            },
                        }
                    );
                    const user = (await userResponse.json()) as {
                        user_id?: unknown;
                        sub?: unknown;
                    };
                    const userId =
                        typeof user.user_id === "string"
                            ? user.user_id
                            : typeof user.sub === "string"
                              ? user.sub
                              : undefined;
                    if (!userResponse.ok || !userId) {
                        throw new Error(`Salesforce userinfo endpoint returned ${userResponse.status}.`);
                    }
                    response.setHeader("Cache-Control", "no-store");
                    response.setHeader("Content-Type", "application/json");
                    response.end(
                        JSON.stringify({
                            accessToken: token.access_token,
                            userId,
                        })
                    );
                } catch (error) {
                    response.statusCode = 502;
                    response.setHeader("Content-Type", "application/json");
                    response.end(
                        JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        })
                    );
                }
            });
        },
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const salesforceInstanceUrl = env.VITE_SALESFORCE_INSTANCE_URL ?? env.SALESFORCE_INSTANCE_URL;
    const browserEnv = (name: string) => JSON.stringify(env[`VITE_${name}`] ?? env[name]);
    return defineAppConfig({
        define: {
            "import.meta.env.VITE_SALESFORCE_CLIENT_ID": browserEnv("SALESFORCE_CLIENT_ID"),
            "import.meta.env.VITE_SALESFORCE_INSTANCE_URL": browserEnv("SALESFORCE_INSTANCE_URL"),
            "import.meta.env.VITE_SALESFORCE_DEV_CREDENTIALS": JSON.stringify(
                Boolean(env.SALESFORCE_CLIENT_SECRET)
            ),
        },
        server: {
            proxy: salesforceInstanceUrl
                ? {
                      "/__salesforce/cometd": {
                          target: salesforceInstanceUrl,
                          changeOrigin: true,
                          cookieDomainRewrite: "",
                          cookiePathRewrite: "/",
                          rewrite: (path) => path.replace(/^\/__salesforce/, ""),
                      },
                  }
                : undefined,
        },
        plugins: [salesforceDevSessionPlugin(env)],
    });
});
