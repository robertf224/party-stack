import * as q from "@party-stack/ontology-spec/query";
import { connectOntology } from "./spec/index.js";
import type { ConnectManagerService } from "./makeConnectManager.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** Device-local public view. It exposes inventory and authentication actions while
 * retaining token ciphertext and PKCE records at the credential owner. Public servers
 * must additionally scope instances/connections to their authenticated caller.
 */
const read = {
    select: [
        q.sub("services", {
            from: { source: { objectType: "ServiceInstance" }, binding: "s" },
            select: ["id", "title", "service", "instanceUrl"].map((name) =>
                q.selectField(name, q.field("s", name))
            ),
        }),
        q.sub("applications", {
            from: { source: { objectType: "OAuthApplication" }, binding: "app" },
            select: ["id", "title", "serviceInstance", "flow", "clientId", "redirectUrl", "scopes"].map(
                (name) => q.selectField(name, q.field("app", name))
            ),
        }),
        ...(["OAuthConnection", "ApiKeyConnection", "ExternalSessionConnection"] as const).map((objectType) =>
            q.sub(objectType, {
                from: { source: { objectType }, binding: "c" },
                select: [
                    "id",
                    "title",
                    "userId",
                    "status",
                    ...(objectType === "OAuthConnection"
                        ? ["application", "accessTokenExpiresAt"]
                        : ["serviceInstance", "expiresAt"]),
                ].map((name) => q.selectField(name, q.field("c", name))),
            })
        ),
    ],
};
export const connectPublicOntologyIR: OntologyIR = {
    ...connectOntology,
    policy: {
        objects: read,
        actions: connectOntology.actionTypes.map((action) => ({
            actionType: action.name,
            check:
                action.name === "beginAuthorization"
                    ? q.exists({
                          from: { source: { objectType: "OAuthApplication" }, binding: "app" },
                          where: q.and(
                              q.eq(q.field("app", "id"), q.input("applicationId")),
                              q.eq(q.field("app", "redirectUrl"), q.input("redirectUrl"))
                          ),
                      })
                    : q.literal(true),
        })),
    },
};

/** Private device ports share an account inventory. A public server must instead
 * bind a caller-specific policy/context; this policy hides secrets but not accounts.
 * Keep the current generic executor behind this composition until owned workflows
 * provide its multi-transaction action lifecycle.
 */
export function connectDeviceRoute(manager: Pick<ConnectManagerService, "backend">) {
    return {
        kind: "proxy" as const,
        backend: manager.backend,
        ir: connectPublicOntologyIR,
        context: {},
    };
}
