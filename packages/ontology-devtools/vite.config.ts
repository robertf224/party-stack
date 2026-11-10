import { defineLibraryConfig } from "@party-stack/build-config";
import tailwindcss from "@tailwindcss/postcss";

export default defineLibraryConfig({
    pack: {
        css: {
            transformer: "postcss",
            postcss: { plugins: [tailwindcss({ optimize: { minify: true } })] },
            splitting: false,
            fileName: "styles.css",
            inject: false,
        },
    },
});
