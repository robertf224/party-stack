import base from "@bobbyfidz/universal-build-config/eslint-base.mjs";

export default [
    ...base,
    {
        rules: {
            // Need to use any a lot because of the nature of this package.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-empty-object-type": "off",
        },
    },
];
