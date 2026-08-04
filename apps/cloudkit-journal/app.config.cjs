const bundleIdentifier =
    process.env.CLOUDKIT_JOURNAL_BUNDLE_ID ??
    "com.partystack.journal";
const containerIdentifier =
    process.env.CLOUDKIT_CONTAINER_ID ??
    `iCloud.${bundleIdentifier}`;

module.exports = {
    expo: {
        name: "CloudKit Journal",
        slug: "cloudkit-journal",
        scheme: "cloudkit-journal",
        version: "0.0.1",
        orientation: "portrait",
        userInterfaceStyle: "automatic",
        ios: {
            bundleIdentifier,
            appleTeamId:
                process.env.CLOUDKIT_APPLE_TEAM_ID ??
                "AG2FP45B4L",
            supportsTablet: true,
        },
        web: {
            bundler: "metro",
        },
        plugins: [
            "expo-dev-client",
            "expo-document-picker",
            [
                "@party-stack/cloudkit-client-expo/app.plugin",
                {
                    containerIdentifiers: [containerIdentifier],
                    environment:
                        process.env.CLOUDKIT_ENVIRONMENT ===
                        "production"
                            ? "Production"
                            : "Development",
                    enableRemoteNotifications: true,
                },
            ],
        ],
        extra: {
            cloudKit: {
                containerIdentifier,
                environment:
                    process.env.CLOUDKIT_ENVIRONMENT ===
                    "production"
                        ? "production"
                        : "development",
                apiToken:
                    process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN ??
                    "",
            },
        },
    },
};
