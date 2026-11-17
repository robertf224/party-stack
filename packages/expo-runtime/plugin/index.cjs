const { createRunOncePlugin, withPlugins } = require("expo/config-plugins");
const withSecureStore = require("expo-secure-store/app.plugin.js").default;
const withSQLite = require("expo-sqlite/app.plugin.js").default;
const withLocation = require("expo-location/app.plugin.js").default;
const { name, version } = require("../package.json");

/**
 * @param {Parameters<import("expo/config-plugins.js").ConfigPlugin>[0]} config
 * @param {{ configureAndroidBackup?: boolean; locationPermission?: string | false }} [options]
 */
const withPartyStack = (config, options = {}) =>
    withPlugins(config, [
        [
            withSecureStore,
            {
                configureAndroidBackup: options.configureAndroidBackup ?? true,
                faceIDPermission: config.ios?.infoPlist?.NSFaceIDUsageDescription ?? false,
            },
        ],
        [withSQLite, {}],
        [
            withLocation,
            {
                // Foreground location only. `false` leaves a purpose string out; an
                // undefined one keeps the app's own or uses expo-location's default.
                locationWhenInUsePermission: options.locationPermission,
                locationAlwaysAndWhenInUsePermission: false,
                locationAlwaysPermission: false,
                motionUsagePermission: false,
            },
        ],
    ]);

module.exports = createRunOncePlugin(withPartyStack, name, version);
