import { Sessions, Contents, SessionExchange } from "@osdk/foundry.aipagents";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import React from "react";
import { useOsdkContext } from "../OsdkContext";

// WIP

export interface UseChatOpts {
    // TODO: make this optional
    sessionRid: string;
}

export interface UseChat<Status extends "submitted" | "streaming" | "ready" | "error"> {
    exchanges: SessionExchange[];
    sendMessage: (content: string) => void;
    status: Status;
    response: Status extends "streaming" ? string : undefined;
}

export function useChat<Status extends "submitted" | "streaming" | "ready" | "error">(
    agentRid: string,
    opts: UseChatOpts
): UseChat<Status> {
    const { client } = useOsdkContext();
    const queryClient = useQueryClient();

    const [state, setState] = React.useState<
        | { type: "ready" }
        | { type: "submitted"; messageId: string }
        | { type: "streaming"; messageId: string; message: string }
        | { type: "error"; error: Error }
    >({
        type: "ready",
    });
    const { data: exchanges } = useSuspenseQuery({
        queryFn: async () => {
            const content = await Contents.get(client, agentRid, opts.sessionRid, { preview: true });
            return content.exchanges;
        },
        queryKey: ["osdk", "agent-session-content", opts.sessionRid],
    });

    const sendMessage = React.useCallback(
        async (content: string) => {
            const messageId = self.crypto.randomUUID();
            setState({ type: "submitted", messageId });
            try {
                const response = await Sessions.streamingContinue(
                    client,
                    agentRid,
                    opts.sessionRid,
                    {
                        userInput: { text: content },
                        parameterInputs: {},
                        messageId,
                    },
                    { preview: true }
                );

                const reader = response.body?.getReader();
                if (!reader) throw new Error("Response body is not readable.");

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        await queryClient.invalidateQueries({
                            queryKey: ["osdk", "agent-session-content", opts.sessionRid],
                        });
                        setState({ type: "ready" });
                    }

                    const chunk = new TextDecoder().decode(value);
                    setState((state) => ({
                        type: "streaming",
                        messageId,
                        message: state.type === "streaming" ? state.message + chunk : chunk,
                    }));
                }
            } catch (error) {
                setState({ type: "error", error: error as Error });
            }
        },
        [client, agentRid, opts.sessionRid]
    );

    return {
        exchanges,
        // TODO: fix
        sendMessage: (content) => void sendMessage(content),
        status: state.type as Status,
        response: (state.type === "streaming" ? state.message : undefined) as Status extends "streaming"
            ? string
            : undefined,
    };
}
