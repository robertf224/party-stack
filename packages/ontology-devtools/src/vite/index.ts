import { transformAsync, types as t, type NodePath, type PluginObj } from "@babel/core";
import type { Plugin } from "vite-plus";

const hooks = new Set(["useLiveQuery", "useLiveInfiniteQuery", "useLiveSuspenseQuery"]);
const marker = "party-stack-demand-attribution";
type ComponentPath = NodePath<t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression>;

function componentName(path: ComponentPath): string | undefined {
    if ((path.isFunctionDeclaration() || path.isFunctionExpression()) && path.node.id)
        return path.node.id.name;
    const parent = path.parentPath;
    return parent.isVariableDeclarator() && t.isIdentifier(parent.node.id) ? parent.node.id.name : undefined;
}

export async function transformDemandAttribution(code: string, filename: string) {
    if (code.includes(marker) || !code.includes("@tanstack/react-db")) return null;
    let modified = false;
    const instrumentation = (): PluginObj => {
        const owners = new Map<t.Node, { path: ComponentPath; name: string; owner: t.Identifier }>();
        let ownerHook: t.Identifier;
        let queryHook: t.Identifier;
        return {
            visitor: {
                Program: {
                    enter(path) {
                        const fresh = (base: string) => {
                            let name = base,
                                suffix = 0;
                            while (path.scope.hasBinding(name)) name = `${base}${++suffix}`;
                            return t.identifier(name);
                        };
                        ownerHook = fresh("usePartyStackDemandOwner");
                        queryHook = fresh("usePartyStackDemandQuery");
                    },
                    exit(path) {
                        if (!owners.size) return;
                        for (const entry of owners.values()) {
                            if (!t.isBlockStatement(entry.path.node.body))
                                entry.path.node.body = t.blockStatement([
                                    t.returnStatement(entry.path.node.body),
                                ]);
                            entry.path.node.body.body.unshift(
                                t.variableDeclaration("const", [
                                    t.variableDeclarator(
                                        entry.owner,
                                        t.callExpression(ownerHook, [
                                            t.stringLiteral(entry.name),
                                            t.stringLiteral(
                                                `${filename}:${entry.path.node.loc?.start.line ?? 1}`
                                            ),
                                        ])
                                    ),
                                ])
                            );
                            entry.path.traverse({
                                JSXOpeningElement(element) {
                                    if (
                                        !t.isJSXIdentifier(element.node.name) ||
                                        !/^[a-z]/u.test(element.node.name.name)
                                    )
                                        return;
                                    let ancestor = element.getFunctionParent();
                                    while (ancestor && !owners.has(ancestor.node))
                                        ancestor = ancestor.getFunctionParent();
                                    if (ancestor?.node !== entry.path.node) return;
                                    if (
                                        element.node.attributes.some(
                                            (attr) =>
                                                t.isJSXAttribute(attr) &&
                                                t.isJSXIdentifier(attr.name, { name: "data-ps-demand-owner" })
                                        )
                                    )
                                        return;
                                    element.node.attributes.push(
                                        t.jsxAttribute(
                                            t.jsxIdentifier("data-ps-demand-owner"),
                                            t.jsxExpressionContainer(
                                                t.memberExpression(
                                                    t.cloneNode(entry.owner),
                                                    t.identifier("id")
                                                )
                                            )
                                        )
                                    );
                                },
                            });
                        }
                        path.unshiftContainer(
                            "body",
                            t.importDeclaration(
                                [
                                    t.importSpecifier(ownerHook, t.identifier("useDemandOwner")),
                                    t.importSpecifier(queryHook, t.identifier("useDemandQuery")),
                                ],
                                t.stringLiteral("@party-stack/ontology-devtools/attribution")
                            )
                        );
                        path.addComment("leading", marker);
                        modified = true;
                    },
                },
                CallExpression(path) {
                    const callee = path.get("callee");
                    if (!callee.isIdentifier()) return;
                    const binding = callee.scope.getBinding(callee.node.name);
                    if (!binding?.path.isImportSpecifier()) return;
                    const imported = binding.path.node.imported;
                    const name = t.isIdentifier(imported) ? imported.name : imported.value;
                    if (
                        !hooks.has(name) ||
                        !binding.path.parentPath.isImportDeclaration() ||
                        binding.path.parentPath.node.source.value !== "@tanstack/react-db"
                    )
                        return;
                    const parent = path.getFunctionParent();
                    if (
                        !parent ||
                        !(
                            parent.isFunctionDeclaration() ||
                            parent.isFunctionExpression() ||
                            parent.isArrowFunctionExpression()
                        )
                    )
                        return;
                    const nameOfComponent = componentName(parent);
                    if (!nameOfComponent || !/^[A-Z]/u.test(nameOfComponent)) return;
                    let entry = owners.get(parent.node);
                    if (!entry) {
                        entry = {
                            path: parent,
                            name: nameOfComponent,
                            owner: parent.scope.generateUidIdentifier("demandOwner"),
                        };
                        owners.set(parent.node, entry);
                    }
                    path.replaceWith(t.callExpression(queryHook, [t.cloneNode(entry.owner), path.node]));
                    path.skip();
                },
            },
        };
    };
    const result = await transformAsync(code, {
        filename,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [instrumentation],
        sourceMaps: true,
        sourceFileName: filename,
    });
    return modified && result?.code ? { code: result.code, map: result.map } : null;
}

/** Opt-in, development-only instrumentation; production source is left untouched. */
export function demandAttribution(): Plugin {
    let root = "";
    return {
        name: "party-stack:demand-attribution",
        apply: "serve",
        enforce: "pre",
        configResolved(config) {
            root = `${config.root}/`;
        },
        async transform(code, id) {
            const file = id.split("?")[0]!;
            if (
                !/\.[jt]sx$/u.test(file) ||
                file.includes("/node_modules/") ||
                file.includes("/ontology-devtools/") ||
                /\.(test|spec)\./u.test(file)
            )
                return;
            return transformDemandAttribution(code, file.startsWith(root) ? file.slice(root.length) : file);
        },
    };
}
