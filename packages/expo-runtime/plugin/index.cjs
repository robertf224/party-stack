const { createRunOncePlugin, withPlugins } = require("expo/config-plugins");
const withSecureStore = require("expo-secure-store/app.plugin.js").default;
const withSQLite = require("expo-sqlite/app.plugin.js").default;
const { name, version } = require("../package.json");

/**
 * @param {Parameters<import("expo/config-plugins.js").ConfigPlugin>[0]} config
 * @param {{ configureAndroidBackup?: boolean }} [options]
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
    ]);

module.exports = createRunOncePlugin(withPartyStack, name, version);
