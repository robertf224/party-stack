import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { Brand } from "../../components/brand";
import { mdxComponents } from "../../components/mdx";
import { source } from "../../lib/source";

export const Route = createFileRoute("/docs/$")({
    loader: ({ params }) => {
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
            nav={{ title: <Brand /> }}
            githubUrl="https://github.com/robertf224/party-stack"
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
