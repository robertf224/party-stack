import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";
const config = defineEffectLibraryConfig();
// Tests import Vite+ directly; avoid aliasing its Vitest re-export back to itself.
config.test = { ...config.test, alias: [] };
export default config;
