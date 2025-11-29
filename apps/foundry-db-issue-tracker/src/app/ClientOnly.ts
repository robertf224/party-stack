import dynamic from "next/dynamic";
import { ComponentType } from "react";

export function ClientOnly<P extends object>(Component: ComponentType<P>): ComponentType<P> {
    return dynamic(() => Promise.resolve(Component), {
        ssr: false,
    }) as ComponentType<P>;
}
