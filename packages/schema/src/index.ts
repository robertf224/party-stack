/**
 * @party-stack/schema - Schema definition and code generation
 *
 * This library provides:
 * - IR for defining schemas (Schema IR)
 * - TypeScript-based IDL for authoring schemas
 * - Validation for schema correctness
 * - TypeScript and Zod code generation
 */

// IR types
export * from "./ir/index.js";

// TypeScript IDL
export * from "./idl/index.js";

// Re-export the main IDL entry point for convenience
export { s } from "./idl/index.js";

// Validation
export * from "./validation/index.js";

// Code generation
export * from "./codegen/index.js";
