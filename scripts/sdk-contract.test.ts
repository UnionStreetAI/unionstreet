import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { RUNTIME_API_ROUTES, UNION_STREET_OPENAPI } from "../packages/server/src/http/openapi.ts";
import { UNION_STREET_SDK_ROUTES } from "../packages/sdk/src/index.ts";

describe("server SDK contract", () => {
  test("sdk route manifest covers every server route marked for sdk coverage", () => {
    const serverRoutes = RUNTIME_API_ROUTES
      .filter((route) => route.sdk === "covered")
      .map(routeKey)
      .sort();
    const sdkRoutes = UNION_STREET_SDK_ROUTES.map(routeKey).sort();

    expect(sdkRoutes, "The SDK route manifest must match server routes marked sdk=covered.").toEqual(serverRoutes);
  });

  test("openapi paths are generated from the canonical server route manifest", () => {
    expect(Object.keys(UNION_STREET_OPENAPI.paths), "OpenAPI paths must stay in lockstep with unique server route paths.").toEqual(
      [...new Set(RUNTIME_API_ROUTES.map((route) => route.path))],
    );
    for (const route of RUNTIME_API_ROUTES) {
      const item = UNION_STREET_OPENAPI.paths[route.path] as Record<string, unknown> | undefined;
      expect(item?.[route.method.toLowerCase()], `OpenAPI must expose ${route.method} ${route.path}.`).toBeTruthy();
    }
  });

  test("sdk covered routes use named OpenAPI schemas instead of anonymous generic objects", () => {
    for (const route of RUNTIME_API_ROUTES.filter((candidate) => candidate.sdk === "covered")) {
      const operation = operationFor(route);
      const successStatus = String(route.successStatus ?? 200);
      const success = operation.responses?.[successStatus] as any;
      if (route.responseContent === "sse") {
        expect(
          success?.content?.["text/event-stream"]?.schema?.type,
          `${routeKey(route)} must document its SSE response content type.`,
        ).toBe("string");
      } else {
        expect(
          success?.content?.["application/json"]?.schema?.$ref,
          `${routeKey(route)} must reference a named JSON response schema.`,
        ).toBe(`#/components/schemas/${route.response}`);
      }

      if (route.method === "POST") {
        expect(route.request, `${routeKey(route)} must name its request schema in the route manifest.`).toBeTruthy();
        expect(
          operation.requestBody?.content?.["application/json"]?.schema?.$ref,
          `${routeKey(route)} must reference a named JSON request schema.`,
        ).toBe(`#/components/schemas/${route.request}`);
      }
    }
  });

  test("openapi component refs point at existing component schemas", () => {
    const schemas = UNION_STREET_OPENAPI.components.schemas as Record<string, unknown>;
    for (const route of RUNTIME_API_ROUTES) {
      expect(schemas[route.response], `${routeKey(route)} response schema ${route.response} must exist.`).toBeTruthy();
      if (route.request) {
        expect(schemas[route.request], `${routeKey(route)} request schema ${route.request} must exist.`).toBeTruthy();
      }
    }
  });

  test("checked in openapi artifact matches the canonical server spec", async () => {
    const artifact = await readFile("docs/openapi.json", "utf8");
    expect(
      `${JSON.stringify(UNION_STREET_OPENAPI, null, 2)}\n`,
      "docs/openapi.json must be regenerated with `bun run openapi:export` after API contract changes.",
    ).toBe(artifact);
  });

  test("generated sdk openapi types match the checked in openapi artifact", async () => {
    const proc = Bun.spawn([
      "bun",
      "run",
      "scripts/generate-openapi-types.ts",
      "docs/openapi.json",
      "-",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr.trim(), "OpenAPI type generation should not write warnings to stderr.").toBe("");
    expect(code, "OpenAPI type generation should succeed.").toBe(0);
    const artifact = await readFile("packages/sdk/src/generated/openapi-types.ts", "utf8");
    expect(stdout, "SDK generated OpenAPI types must be regenerated with `bun run openapi:types`.").toBe(artifact);
  });
});

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function operationFor(route: { method: string; path: string }): any {
  const item = UNION_STREET_OPENAPI.paths[route.path] as Record<string, any> | undefined;
  return item?.[route.method.toLowerCase()];
}
