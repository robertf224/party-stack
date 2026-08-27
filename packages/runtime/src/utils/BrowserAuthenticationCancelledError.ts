export class BrowserAuthenticationCancelledError extends Error {
    constructor(message = "Browser authentication was cancelled.") {
        super(message);
        this.name = "BrowserAuthenticationCancelledError";
    }
}
