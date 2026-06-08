export type * from "@party-stack/schema/values";

export type attachment = {
    id: string;
    size?: number;
    type?: string;
    name?: string;
    source?: {
        objectType: string;
        primaryKey: string | number;
        property: string;
    };
};
