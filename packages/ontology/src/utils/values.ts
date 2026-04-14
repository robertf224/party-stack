export * from "@party-stack/schema/values";

// TODO: revisit this (https://valinor-enterprises.slack.com/archives/C08549X3VDM/p1776138662547679)
export type attachment = {
    id: string;
    metadata: () => Promise<Pick<Blob, "size" | "type">>;
    blob: () => Promise<Blob>;
};
