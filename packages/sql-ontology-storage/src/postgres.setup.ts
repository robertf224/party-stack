import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vite-plus/test/node";

export const startPostgres = () => new PostgreSqlContainer("postgres:18-alpine").start();

export default async function setup(project: TestProject) {
    const postgres = await startPostgres();
    project.provide("postgresUrl", postgres.getConnectionUri());
    return async () => {
        await postgres.stop();
    };
}

declare module "vitest" {
    export interface ProvidedContext {
        postgresUrl: string;
    }
}
