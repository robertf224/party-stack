import { Schema } from "effect";

export class BrowserAuthenticationError extends Schema.TaggedError<BrowserAuthenticationError>()(
    "BrowserAuthenticationError",
    {
        /** `PopupBlocked`: the browser refused to open the sign-in popup; a redirect can still work. */
        reason: Schema.Literals(["Cancelled", "Configuration", "Platform", "PopupBlocked"]),
        message: Schema.String,
        cause: Schema.optional(Schema.Defect()),
    }
) {}
