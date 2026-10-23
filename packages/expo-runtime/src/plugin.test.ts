import { createRequire } from "node:module";
import { expect, test } from "vite-plus/test";
import type plugin from "../plugin/index.cjs";
import type { ExportedConfig } from "expo/config-plugins.js";

// Exercise the same CommonJS entry Expo resolves, without importing the native runtime.
const require = createRequire(import.meta.url);
const withPartyStack: typeof plugin = require("@party-stack/expo-runtime/plugin");
const config = (): ExportedConfig => ({
    name: "Test",
    slug: "test",
    _internal: { projectRoot: "/party-stack-test-consumer" },
});

test("registers native plugins once, configures backups and does not request Face ID", () => {
    const result: ExportedConfig = withPartyStack(config());
    expect(result.ios?.infoPlist?.NSFaceIDUsageDescription).toBeUndefined();
    const history = result._internal?.pluginHistory;
    expect(Object.keys(history ?? {})).toEqual(
        expect.arrayContaining(["expo-secure-store", "expo-sqlite", "@party-stack/expo-runtime"])
    );
    expect(withPartyStack(result)).toBe(result);
    expect(result.mods?.android?.manifest).toBeTypeOf("function");
    expect(result.mods?.android?.gradleProperties).toBeTypeOf("function");
});

test("preserves an application-provided Face ID description", () => {
    const input = config();
    input.ios = { infoPlist: { NSFaceIDUsageDescription: "Unlock another app capability" } };
    expect(withPartyStack(input).ios?.infoPlist?.NSFaceIDUsageDescription).toBe(
        "Unlock another app capability"
    );
});

test("applies SecureStore backup exclusions without overriding custom backup rules", async () => {
    for (const custom of [false, true]) {
        const result: ExportedConfig = withPartyStack(config());
        const manifest = result.mods!.android!.manifest!;
        const application = {
            $: {
                "android:name": ".MainApplication",
                ...(custom
                    ? {
                          "android:fullBackupContent": "@xml/app_backup",
                          "android:dataExtractionRules": "@xml/app_extraction",
                      }
                    : {}),
            },
        };
        const output = await manifest({
            ...result,
            modResults: {
                manifest: {
                    $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
                    application: [application],
                    queries: [],
                },
            },
            modRequest: {
                projectRoot: "/test",
                platformProjectRoot: "/test/android",
                modName: "manifest",
                platform: "android",
                introspect: true,
                ignoreExistingNativeFiles: true,
            },
            modRawConfig: result,
        });
        expect(output.modResults.manifest.application?.[0]?.$["android:fullBackupContent"]).toBe(
            custom ? "@xml/app_backup" : "@xml/secure_store_backup_rules"
        );
        expect(output.modResults.manifest.application?.[0]?.$["android:dataExtractionRules"]).toBe(
            custom ? "@xml/app_extraction" : "@xml/secure_store_data_extraction_rules"
        );
    }
});
