---
"@party-stack/runtime": patch
"@party-stack/web-runtime": patch
"@party-stack/connect": patch
---

A sign-in popup the browser blocks now fails with `BrowserAuthenticationError` reason
`PopupBlocked`, and Connect keeps that error as the `cause` of the sign-in failure, so
an app can retry with `browserPresentation: "redirect"`. Issue tracker does this.
