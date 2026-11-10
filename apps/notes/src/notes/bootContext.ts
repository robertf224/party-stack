import { createContext, useContext, useEffect } from "react";

export const BootContext = createContext({ ready: true, loaded: (_part: string) => {} });

export function useBootSignal(part: string) {
    const { loaded } = useContext(BootContext);
    useEffect(() => loaded(part), [loaded, part]);
}
