import type { ConfigPlugin } from "expo/config-plugins.js";
interface PartyStackPluginOptions {
    /** Keep SecureStore values out of Android backups. Defaults to true.
     * Disable only when supplying equivalent custom backup rules.
     */
    readonly configureAndroidBackup?: boolean;
    /** iOS purpose string for location while the app is in use. Defaults to the app's
     * existing one or expo-location's. `false` leaves it out for apps that never read
     * location. Background location is never requested. */
    readonly locationPermission?: string | false;
}
declare const withPartyStack: ConfigPlugin<PartyStackPluginOptions | void>;
export = withPartyStack;
