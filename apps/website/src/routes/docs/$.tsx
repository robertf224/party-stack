import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { mdxComponents } from "../../components/mdx";
import { source } from "../../docs/source";
import type { SidebarPageTreeComponents } from "fumadocs-ui/components/sidebar/page-tree";
import type { CSSProperties } from "react";

const sidebarComponents: Partial<SidebarPageTreeComponents> = {
    Separator: ({ item }) => (
        <p className="docs-sidebar-section">
            {item.icon}
            {item.name}
        </p>
    ),
};

export const Route = createFileRoute("/docs/$")({
    loader: ({ params }) => {
        const moved: Record<string, string> = {
            runtimes: "tanstack-start",
            storage: "attachments",
            replica: "offline",
        };
        const destination = moved[params._splat ?? ""];
        if (destination) throw redirect({ to: "/docs/$", params: { _splat: destination }, replace: true });
        const page = source.getPage(params._splat?.split("/").filter(Boolean));
        if (!page) throw notFound();
        return { slugs: page.slugs };
    },
    head: ({ loaderData }) => {
        const page = loaderData && source.getPage(loaderData.slugs);
        return {
            meta: [{ title: page ? `${page.data.title} | Party Stack` : "Documentation | Party Stack" }],
        };
    },
    component: Documentation,
});

function Documentation() {
    const { slugs } = Route.useLoaderData();
    const page = source.getPage(slugs)!;
    const Content = page.data.body;
    return (
        <DocsLayout
            tree={source.pageTree}
            slots={{ navTitle: () => null }}
            sidebar={{ collapsible: false, components: sidebarComponents }}
            themeSwitch={{ enabled: false }}
            containerProps={{
                className: "docs-layout",
                style: {
                    "--fd-docs-row-1": "var(--site-header-height)",
                    "--fd-docs-height": "calc(100dvh - var(--site-header-height))",
                } as CSSProperties,
            }}
        >
            <DocsPage toc={page.data.toc}>
                <DocsTitle>{page.data.title}</DocsTitle>
                <DocsDescription>{page.data.description}</DocsDescription>
                <DocsBody>
                    <Content components={mdxComponents} />
                </DocsBody>
            </DocsPage>
        </DocsLayout>
    );
}
