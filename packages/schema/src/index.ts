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

// Validation
export * from "./validate/index.js";

// Code generation
export * from "./generate/index.js";
