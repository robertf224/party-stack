import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

const config = defineEffectLibraryConfig();
// These tests import Vite+'s test API directly. Aliasing its Vitest re-export
// back to itself creates a second runner context under workspace scheduling.
config.test = { ...config.test, alias: [] };
export default config;
