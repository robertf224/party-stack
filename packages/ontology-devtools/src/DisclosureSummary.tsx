import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function DisclosureSummary({ children }: { children: ReactNode }) {
    return (
        <summary className="ps-disclosure-summary">
            <ChevronRight className="ps-disclosure-chevron" size={12} aria-hidden />
            <span className="ps-disclosure-label">{children}</span>
        </summary>
    );
}
