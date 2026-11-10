import type {
    PropertyApiName,
    PropertyIdentifier,
    SearchJsonQueryV2,
    StructFieldApiName,
} from "@osdk/foundry.ontologies";

const ALWAYS_TRUE_FILTER: SearchJsonQueryV2 = { type: "and", value: [] };

type LikePatternPart = { type: "literal"; value: string } | { type: "many" } | { type: "single" };

interface PushdownFilter {
    query: SearchJsonQueryV2;
    safeToNegate: boolean;
}

function pushdown(query: SearchJsonQueryV2, safeToNegate = true): PushdownFilter {
    return { query, safeToNegate };
}

function parseLikePattern(pattern: string, literalBackslashes = false): LikePatternPart[] {
    const parts: LikePatternPart[] = [];
    let literal = "";

    const flushLiteral = () => {
        if (literal) {
            parts.push({ type: "literal", value: literal });
            literal = "";
        }
    };

    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index]!;
        if (character === "\\" && !literalBackslashes) {
            const escaped = pattern[index + 1];
            if (escaped === "%" || escaped === "_" || escaped === "\\") {
                literal += escaped;
                index++;
            } else {
                literal += character;
            }
        } else if (character === "%") {
            flushLiteral();
            parts.push({ type: "many" });
        } else if (character === "_") {
            flushLiteral();
            parts.push({ type: "single" });
        } else {
            literal += character;
        }
    }
    flushLiteral();

    return parts;
}

function escapeFoundryWildcardLiteral(value: string): string {
    return value.replace(/[\\*?]/g, "\\$&");
}

export function convertLikeFilter(
    field: readonly (string | number)[],
    value: string,
    literalBackslashes = false
): PushdownFilter {
    const parts = parseLikePattern(value.toLowerCase(), literalBackslashes);
    const hasLeadingWildcard = parts[0]?.type === "many";
    const hasTrailingWildcard = parts.at(-1)?.type === "many";
    const propertyIdentifier = fieldPathToPropertyIdentifier(field);

    if (hasLeadingWildcard && hasTrailingWildcard) {
        const terms = parts.flatMap((part) => (part.type === "literal" && part.value ? [part.value] : []));
        const queries = terms.map<SearchJsonQueryV2>((term) => ({
            // This is Foundry's substring/phrase query. It can over-fetch because
            // wildcard-delimited terms are not required to be adjacent or ordered.
            type: "containsAllTermsInOrder",
            propertyIdentifier,
            value: term,
        }));
        const query: SearchJsonQueryV2 =
            queries.length === 0
                ? ALWAYS_TRUE_FILTER
                : queries.length === 1
                  ? queries[0]!
                  : { type: "and", value: queries };

        // Contains is an approximation of SQL LIKE. Negating this superset
        // would produce a subset and could hide exact matches.
        return pushdown(query, false);
    }

    const wildcard = parts
        .map((part) => {
            if (part.type === "many") return "*";
            if (part.type === "single") return "?";
            return escapeFoundryWildcardLiteral(part.value);
        })
        .join("");

    return pushdown({
        type: "wildcard",
        propertyIdentifier,
        value: wildcard,
    });
}

function fieldPathToPropertyIdentifier(fieldPath: readonly (string | number)[]): PropertyIdentifier {
    if (fieldPath.length === 1) {
        return {
            type: "property",
            apiName: fieldPath[0]! as PropertyApiName,
        };
    } else if (fieldPath.length === 2) {
        return {
            type: "structField",
            propertyApiName: fieldPath[0]! as PropertyApiName,
            structFieldApiName: fieldPath[1]! as StructFieldApiName,
        };
    }
    throw new Error(`Invalid field path: ${fieldPath.join(".")}`);
}
