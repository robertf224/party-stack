import React, { useState } from "react";
import { useChat, SessionExchange } from "@bobbyfidz/osdk-react/ai";
import ReactMarkdown from "react-markdown";

interface ChatWindowProps {
    agentRid: string;
    sessionRid: string;
}

export default function ChatWindow({ agentRid, sessionRid }: ChatWindowProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [message, setMessage] = useState("");
    const { exchanges, sendMessage, status, response } = useChat<
        "submitted" | "streaming" | "ready" | "error"
    >(agentRid, { sessionRid });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (message.trim()) {
            sendMessage(message);
            setMessage("");
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-50">
            {!isOpen ? (
                <button
                    onClick={() => setIsOpen(true)}
                    className="rounded-full bg-blue-500 p-4 text-white shadow-lg hover:bg-blue-600"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-6 w-6"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                    </svg>
                </button>
            ) : (
                <div className="flex h-[500px] w-[350px] flex-col rounded-lg bg-white shadow-xl">
                    <div className="flex items-center justify-between border-b p-4">
                        <h3 className="text-lg font-semibold">Chat Assistant</h3>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="text-gray-500 hover:text-gray-700"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-6 w-6"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                        {exchanges.map((exchange: SessionExchange, index) => (
                            <div key={index} className="mb-4 space-y-4">
                                <div>
                                    <div className="mb-2 text-sm font-semibold text-gray-600">You</div>
                                    <div className="rounded-lg bg-gray-100 p-3">
                                        {exchange.userInput.text}
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-2 text-sm font-semibold text-gray-600">Assistant</div>
                                    <div className="rounded-lg bg-gray-100 p-3">
                                        <ReactMarkdown>{exchange.result.agentMarkdownResponse}</ReactMarkdown>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {status === "submitted" && (
                            <div className="mb-4">
                                <div className="mb-2 text-sm font-semibold text-gray-600">Assistant</div>
                                <div className="rounded-lg bg-gray-100 p-3">
                                    <div className="flex items-center gap-2">
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400"></div>
                                        <div
                                            className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                                            style={{ animationDelay: "0.2s" }}
                                        ></div>
                                        <div
                                            className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                                            style={{ animationDelay: "0.4s" }}
                                        ></div>
                                    </div>
                                </div>
                            </div>
                        )}
                        {status === "streaming" && response && (
                            <div className="mb-4">
                                <div className="mb-2 text-sm font-semibold text-gray-600">Assistant</div>
                                <div className="rounded-lg bg-gray-100 p-3">
                                    <ReactMarkdown>{response}</ReactMarkdown>
                                </div>
                            </div>
                        )}
                        {status === "error" && (
                            <div className="mb-4">
                                <div className="mb-2 text-sm font-semibold text-red-600">Error</div>
                                <div className="rounded-lg bg-red-50 p-3 text-red-600">
                                    Something went wrong. Please try again.
                                </div>
                            </div>
                        )}
                    </div>
                    <form onSubmit={handleSubmit} className="border-t p-4">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                placeholder="Type your message..."
                                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                            />
                            <button
                                type="submit"
                                disabled={status === "submitted"}
                                className="rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
                            >
                                Send
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
