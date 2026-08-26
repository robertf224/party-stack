import { invariant } from "@bobbyfidz/panic";
import { base64url, decodeJwt } from "jose";

export interface FoundryTokenDetails {
    userId: string;
    expiresAt?: number;
}

export function getTokenDetails(token: string): FoundryTokenDetails {
    const { sub, exp } = decodeJwt(token);
    invariant(sub, "Expected a sub claim in the token.");
    const bytes = base64url.decode(sub.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    invariant(bytes.length === 16, "Expected 16 bytes of data.");
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return {
        userId: `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`,
        expiresAt: exp === undefined ? undefined : exp * 1_000,
    };
}
