import { useId, type SVGProps } from "react";
import { DiscoBallArtwork } from "./disco-ball.js";

/** Shared silver disco ball. A circular clip preserves its silhouette at every size. */
export function PartyStackLogomark(props: SVGProps<SVGSVGElement>) {
    const id = useId();
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 512 512"
            preserveAspectRatio="xMidYMid meet"
            {...props}
            style={{ display: "block", height: "100%", width: "100%", ...props.style }}
        >
            <DiscoBallArtwork id={id} />
        </svg>
    );
}

export function PartyStackLogo({
    theme,
    ...props
}: SVGProps<SVGSVGElement> & { readonly theme?: "light" | "dark" }) {
    const id = useId();
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 1200 300"
            preserveAspectRatio="xMidYMid meet"
            {...props}
            style={{ display: "block", height: "100%", width: "100%", ...props.style }}
        >
            <g transform="scale(.5859375)">
                <DiscoBallArtwork id={id} />
            </g>
            <text
                fill={theme === undefined ? "currentColor" : theme === "dark" ? "#f7f5f0" : "#171717"}
                fontFamily="Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
                fontSize="124"
                fontWeight="700"
                letterSpacing="-3"
                x="310"
                y="196"
            >
                Party Stack
            </text>
        </svg>
    );
}
