"use client";

import { getUserIdFromToken } from "@bobbyfidz/osdk-utils";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useOsdkContext } from "../OsdkContext";

export function useCurrentUserId(): string {
    const { client } = useOsdkContext();
    const { data: token } = useSuspenseQuery({
        queryFn: () => client.__osdkClientContext.tokenProvider(),
        queryKey: ["osdk", "current-user-id"],
        staleTime: Infinity,
    });
    return getUserIdFromToken(token);
}
