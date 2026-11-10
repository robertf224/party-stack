import { useOntology } from "@party-stack/ontology-react";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { TriangleAlert } from "lucide-react";

export function OutboxWarning() {
    const ontology = useOntology();
    const { data } = useLiveSuspenseQuery((q) => q.from({ action: ontology.outbox.collection }));
    const failed = data.find((entry) => entry.status === "blocked" || entry.lastError);
    return failed ? (
        <div className="error-banner" role="status">
            <TriangleAlert size={14} />
            Changes are waiting to sync. {failed.lastError?.message}
            <button onClick={() => void ontology.outbox.retry(failed.id).catch(() => {})}>Retry</button>
        </div>
    ) : null;
}
