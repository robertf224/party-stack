import { Link, useLocation } from "@tanstack/react-router";
import { Brand } from "./brand";

function GitHubLogo() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542 0-.267-.01-.974-.015-1.912-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.077-.685.077-.685 1.13.08 1.724 1.16 1.724 1.16 1.005 1.723 2.638 1.225 3.28.937.102-.729.393-1.226.715-1.508-2.498-.284-5.124-1.249-5.124-5.56 0-1.23.44-2.234 1.16-3.022-.116-.285-.503-1.43.11-2.98 0 0 .945-.303 3.094 1.154a10.8 10.8 0 0 1 2.81-.378c.955.004 1.918.129 2.815.378 2.147-1.457 3.09-1.154 3.09-1.154.615 1.55.228 2.695.112 2.98.722.788 1.157 1.792 1.157 3.022 0 4.322-2.63 5.272-5.135 5.55.404.348.765 1.035.765 2.085 0 1.505-.014 2.72-.014 3.09 0 .301.203.652.774.541A11.25 11.25 0 0 0 12 .75Z" />
        </svg>
    );
}

export function SiteHeader() {
    const home = useLocation({ select: (location) => location.pathname === "/" });
    return (
        <header className={`site-header${home ? " site-header-home" : ""}`}>
            <Link to="/" aria-label="Party Stack home">
                <Brand />
            </Link>
            <nav aria-label="Main navigation">
                <Link
                    to="/docs/$"
                    params={{ _splat: undefined }}
                    activeOptions={{ exact: false }}
                    activeProps={{ "aria-current": "page" }}
                >
                    Docs
                </Link>
                <a
                    href="https://github.com/robertf224/party-stack"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="GitHub"
                    title="GitHub"
                >
                    <GitHubLogo />
                </a>
            </nav>
        </header>
    );
}
