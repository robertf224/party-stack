/** @type {import("syncpack").RcFile} */
const config = {
    dependencyTypes: ["prod", "dev"],
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
