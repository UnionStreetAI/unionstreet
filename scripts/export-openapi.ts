#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UNION_STREET_OPENAPI } from "../packages/server/src/http/openapi.ts";

const outputPath = resolve(process.argv[2] ?? "docs/openapi.json");
const contents = `${JSON.stringify(UNION_STREET_OPENAPI, null, 2)}\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, contents);
console.log(`wrote ${outputPath}`);
