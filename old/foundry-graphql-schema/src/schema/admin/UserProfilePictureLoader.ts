import { Users } from "@osdk/foundry.admin";
import { PrincipalId } from "@osdk/foundry.core";
import { loadOneCallback } from "grafast";
import { Base64 } from "js-base64";
import { FoundryContext } from "../context.js";

async function responseToDataURL(response: Response): Promise<string> {
    if (typeof window === "undefined") {
        const contentType = response.headers.get("content-type") ?? "application/octet-stream";
        const bytes = await response.bytes();
        const base64 = Base64.fromUint8Array(bytes);
        return `data:${contentType};base64,${base64}`;
    } else {
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                resolve(reader.result as string);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}

export const UserProfilePictureLoader = loadOneCallback<PrincipalId, string, {}, FoundryContext>(
    async (ids, { unary: context }) => {
        return Promise.all(ids.map((id) => Users.profilePicture(context.client, id).then(responseToDataURL)));
    }
);
