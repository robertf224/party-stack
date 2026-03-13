import base from "@bobbyfidz/react-build-config/eslint-base.mjs";

export default [
    ...base,
    {
        rules: {
            "react/prop-types": "off",
        },
    },
];
