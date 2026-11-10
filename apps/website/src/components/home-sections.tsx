import { Tabs } from "@base-ui/react/tabs";
import { Link } from "@tanstack/react-router";
import {
    ArrowUpRight,
    Database,
    Globe,
    HardDrive,
    KeyRound,
    LockKeyhole,
    Paperclip,
    Radio,
    ShieldCheck,
    WifiOff,
    Zap,
} from "lucide-react";
import type { ComponentType } from "react";

const guests = [
    {
        id: "runtimes",
        title: "Runtimes",
        icon: Globe,
        heading: "Wherever your app lives.",
        description:
            "Keep a memory view near the UI and a persistent owner where it makes sense for your app.",
        items: [
            "Browser tabs",
            "SharedWorkers",
            "Expo · iOS & Android",
            "Node.js",
            "Cloudflare Workers & Durable Objects",
        ],
        code: `// One persistent owner, many local views.\n<OntologyProvider\n  client={workerClient(spawnWorker)}\n  runtime={webRuntime({ storage: "memory" })}\n>\n  <App />\n</OntologyProvider>`,
        href: "tanstack-start",
    },
    {
        id: "backends",
        title: "Backends",
        icon: Database,
        heading: "Bring the systems you already use.",
        description:
            "Use an existing ontology, own your database, or adapt another API. Your components keep the same query and action APIs.",
        items: ["Foundry", "Salesforce", "Owned SQLite", "Durable Objects", "Your own adapter"],
        code: `const server = yield* makeOntologyServer({\n  routes: {\n    issues: { kind: "owned", backend, authenticate },\n    catalogue: {\n      kind: "proxy",\n      backend: catalogueBackend, ir, authenticate,\n    },\n  },\n});`,
        href: "server",
    },
    {
        id: "storage",
        title: "Storage",
        icon: HardDrive,
        heading: "A home for every kind of data.",
        description:
            "Object tables and attachment bytes share a lifecycle, with storage suited to each environment.",
        items: ["Memory", "IndexedDB", "SQLite", "OPFS attachment bytes", "R2 attachment bytes"],
        code: `// Browser owner: IndexedDB + OPFS.\nwebRuntime();\n\n// A tab's local working set.\nwebRuntime({ storage: "memory" });\n\n// Mobile owner: SQLite + device files.\nexpoRuntime();`,
        href: "offline",
    },
];
const capabilities = [
    {
        id: "queries",
        title: "Live queries",
        icon: Radio,
        heading: "Keep the UI in the loop.",
        description:
            "Declare what a component needs. Queries acquire the data and update as local or remote changes arrive.",
        code: `const { data } = useLiveSuspenseQuery(q =>\n  q.from({ todo: objects.Todo })\n    .where(({ todo }) => eq(todo.done, false))\n);`,
        href: "queries",
    },
    {
        id: "actions",
        title: "Optimistic actions",
        icon: Zap,
        heading: "Let people keep moving.",
        description:
            "Predict changes locally while the outbox delivers them to the authority. Confirmation and recovery belong to the replica.",
        code: `// With writes.defaultVisibility: "optimistic".\nawait ontology.actions.createTodo({\n  title: "Invite your friends",\n});`,
        href: "actions",
    },
    {
        id: "offline",
        title: "Offline data",
        icon: WifiOff,
        heading: "The party doesn't stop at the door.",
        description:
            "Keep a graph of objects and its files on the device. Read retained data and queue changes without a connection.",
        code: `await ontology.pins.set(projectGraph, {\n  inputs: { projectId },\n  attachments: "all",\n});`,
        href: "offline",
    },
    {
        id: "attachments",
        title: "Attachments",
        icon: Paperclip,
        heading: "Bring more than rows.",
        description:
            "Pass files to actions and show them in your UI. Replicas handle byte transfers, references, and cache cleanup.",
        code: `await ontology.actions.createIssue({\n  title: "A little inspiration",\n  attachments: [file],\n});\n\nconst url = useAttachmentUrl(image);`,
        href: "attachments",
    },
    {
        id: "encryption",
        title: "Encrypted values",
        icon: LockKeyhole,
        heading: "Some things stay between friends.",
        description:
            "Encrypted properties travel as opaque values. Request authorized plaintext when you need it.",
        code: `const secret = await ontology.decrypt(\n  account.accessToken\n);`,
        href: "encrypted-values",
    },
    {
        id: "authentication",
        title: "Authentication",
        icon: KeyRound,
        heading: "Let your people in.",
        description:
            "Sign in, save accounts, and switch between them. Use OAuth or attach a session from Better Auth.",
        code: `const authentication = useAuthentication();\nconst oauth = authentication.oauth({\n  applicationId: "app", redirectUrl,\n});\nconst account = await oauth.signIn({\n  browserPresentation: "popup",\n});`,
        href: "authentication",
    },
    {
        id: "authorization",
        title: "Authorization",
        icon: ShieldCheck,
        heading: "Give everyone the right access.",
        description:
            "Describe the graph a caller may read and the actions they may take. Party Stack applies it across queries, caches, and files.",
        code: `policy: {\n  objects: projectsAndTheirNotes,\n  actions: [{\n    actionType: "createNote",\n    check: canEditProject,\n    bind: [{ parameter: "author",\n      expression: context("userId") }],\n  }],\n}`,
        href: "authorization",
    },
];

type Entry = {
    id: string;
    title: string;
    icon: ComponentType<{ size?: number }>;
    heading: string;
    description: string;
    code: string;
    href: string;
    items?: string[];
};
function Menu({ entries, label }: { entries: Entry[]; label: string }) {
    return (
        <Tabs.Root defaultValue={entries[0]!.id} className="home-menu" orientation="vertical">
            <Tabs.List className="home-menu-list" aria-label={label}>
                {entries.map(({ id, title, icon: Icon }) => (
                    <Tabs.Tab key={id} value={id}>
                        <Icon size={18} />
                        <span>{title}</span>
                        <ArrowUpRight size={14} />
                    </Tabs.Tab>
                ))}
            </Tabs.List>
            {entries.map((entry) => (
                <Tabs.Panel key={entry.id} value={entry.id} className="home-menu-panel">
                    <h3>{entry.heading}</h3>
                    <p>{entry.description}</p>
                    {entry.items && (
                        <ul className="home-guest-list">
                            {entry.items.map((item) => (
                                <li key={item}>{item}</li>
                            ))}
                        </ul>
                    )}
                    <pre>
                        <code>{entry.code}</code>
                    </pre>
                    <Link to="/docs/$" params={{ _splat: entry.href }}>
                        Explore {entry.title.toLowerCase()} <ArrowUpRight size={14} />
                    </Link>
                </Tabs.Panel>
            ))}
        </Tabs.Root>
    );
}

export function HomeSections() {
    return (
        <>
            <section className="home-section" aria-labelledby="guests-title">
                <p className="home-kicker">The guest list</p>
                <h2 id="guests-title">Everyone's invited.</h2>
                <p className="home-section-intro">Your app, your systems, your choice of where data lives.</p>
                <Menu entries={guests} label="Explore supported environments" />
            </section>
            <section className="home-section" aria-labelledby="capabilities-title">
                <p className="home-kicker">On the house</p>
                <h2 id="capabilities-title">The details are taken care of.</h2>
                <p className="home-section-intro">Everything behind a great experience, working together.</p>
                <Menu entries={capabilities} label="Explore capabilities" />
            </section>
        </>
    );
}
