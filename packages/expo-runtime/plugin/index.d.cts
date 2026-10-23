import type { ConfigPlugin } from "expo/config-plugins.js";
interface PartyStackPluginOptions {
    /** Keep SecureStore values out of Android backups. Defaults to true.
     * Disable only when supplying equivalent custom backup rules.
     */
    readonly configureAndroidBackup?: boolean;
}
declare const withPartyStack: ConfigPlugin<PartyStackPluginOptions | void>;
export = withPartyStack;
