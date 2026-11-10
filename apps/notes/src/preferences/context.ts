import { createContext, useContext } from "react";

export type PanelWidths = { folders: number; notes: number };
export const PreferencesContext = createContext<
    | {
          widths: PanelWidths;
          setWidths(widths: PanelWidths): Promise<unknown>;
      }
    | undefined
>(undefined);
export function usePreferences() {
    const preferences = useContext(PreferencesContext);
    if (!preferences) throw new Error("Preferences are not open.");
    return preferences;
}
