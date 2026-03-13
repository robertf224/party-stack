"use client";

import { Users } from "@osdk/foundry.admin";
import { useSuspenseQuery } from "@tanstack/react-query";
import { UseSuspenseQueryResult } from "@tanstack/react-query";
import { useOsdkContext } from "../OsdkContext";
import { blobToDataUrl } from "../utils/blobToDataUrl";
export function useUserProfilePicture(userId: string): UseSuspenseQueryResult<string | null> {
    const { client } = useOsdkContext();
    return useSuspenseQuery({
        queryFn: async () => {
            const result = await Users.profilePicture(client, userId);
            // Typing is wrong here.
            if (result) {
                const blob = await result.blob();
                return blobToDataUrl(blob);
            }
            return null;
        },
        queryKey: ["osdk", "user-profile-picture", userId],
    });
}
