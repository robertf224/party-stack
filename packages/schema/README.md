# @party-stack/schema

A self-describing schema library. It's a low-level but important part of our ecosystem for structured data flow.

You start with a schema definition and generate Typescript types, Zod validators, and builder functions for your schema. The [schema IR](./src/ir/schema.ts) format is described in the schema IR format, and we use that to generate the types/validators/builders for interacting with schemas.

### Roadmap

- Array constraints + cleaner builders
- Standard JSON encoding (+ codecs generally)
- Default values
- Possibly switching to a more rich Result type in IR (e.g. better-result, neverthrow)
- Other schema definition front-ends besides our generated builders (e.g. Typescript!)
- Export filtering
