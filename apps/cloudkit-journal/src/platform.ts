import type { CloudKitClient } from "@party-stack/cloudkit-client";
import type { CreateLiveOntologyOpts } from "@party-stack/ontology";

export interface JournalPlatformServices {
    client: CloudKitClient;
    runtime: NonNullable<CreateLiveOntologyOpts["runtime"]>;
    accountStatus: string;
    platformDescription: string;
    signIn?: () => void;
}

export async function createJournalPlatformServices(): Promise<JournalPlatformServices> {
    throw new Error(
        "CloudKit Journal does not support this platform."
    );
}
