---
"@party-stack/ontology-server": patch
---

A route that fails to open is no longer cached. Routes stay open for `idleRetentionMs` after their last request, but a failed open was kept the same way. Every retry got the cached failure and restarted its idle timer, so the route stayed broken until requests stopped for the whole retention period or the page reloaded. The next request after a failure now opens the route again. Requests already waiting on the failed open still share its error.
