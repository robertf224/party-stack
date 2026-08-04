const {
    withEntitlementsPlist,
    withInfoPlist,
} = require("@expo/config-plugins");

function withPartyStackCloudKit(config, props = {}) {
    const containerIdentifiers =
        props.containerIdentifiers ??
        (config.ios?.bundleIdentifier
            ? [`iCloud.${config.ios.bundleIdentifier}`]
            : []);
    if (containerIdentifiers.length === 0) {
        throw new Error(
            "@party-stack/cloudkit-client-expo requires containerIdentifiers or expo.ios.bundleIdentifier."
        );
    }
    const environment =
        props.environment ?? "Development";

    config = withEntitlementsPlist(config, (entry) => {
        entry.modResults[
            "com.apple.developer.icloud-container-identifiers"
        ] = containerIdentifiers;
        entry.modResults["com.apple.developer.icloud-services"] = [
            "CloudKit",
        ];
        entry.modResults[
            "com.apple.developer.icloud-container-environment"
        ] = environment;
        if (props.enableRemoteNotifications !== false) {
            entry.modResults["aps-environment"] =
                environment === "Production"
                    ? "production"
                    : "development";
        }
        return entry;
    });

    config = withInfoPlist(config, (entry) => {
        entry.modResults.PartyStackCloudKitContainerIdentifiers =
            containerIdentifiers;
        if (props.enableRemoteNotifications !== false) {
            const backgroundModes = new Set(
                entry.modResults.UIBackgroundModes ?? []
            );
            backgroundModes.add("remote-notification");
            entry.modResults.UIBackgroundModes = [
                ...backgroundModes,
            ];
        }
        return entry;
    });

    return config;
}

module.exports = withPartyStackCloudKit;
