/** @type {import("syncpack").RcFile} */
const config = {
    dependencyTypes: ["prod", "dev"],
    versionGroups: [
        {
            label: "Cloudflare Vitest integration requires Vitest 4",
            packages: ["@party-stack/cloudflare-sqlite-ontology"],
            dependencies: ["vitest"],
            isIgnored: true,
        },
    ],
    semverGroups: [
        {
            range: "~",
            dependencies: ["typescript"],
        },
        {
            range: "",
            dependencies: ["next", "eslint-config-next", "turbo"],
        },
        {
            specifierTypes: ["workspace-protocol", "file"],
            isIgnored: true,
        },
        {
            range: "^",
        },
    ],
    lintFormatting: false,
};

module.exports = config;
