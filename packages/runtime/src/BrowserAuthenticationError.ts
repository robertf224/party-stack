import { Schema } from "effect";

export class BrowserAuthenticationError extends Schema.TaggedError<BrowserAuthenticationError>()(
    "BrowserAuthenticationError",
    {
        reason: Schema.Literals(["Cancelled", "Configuration", "Platform"]),
        message: Schema.String,
        cause: Schema.optional(Schema.Defect()),
    }
) {}
