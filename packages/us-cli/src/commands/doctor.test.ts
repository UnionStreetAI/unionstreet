import { describe, expect, test } from "bun:test";
import { requiredChecksPassed } from "./doctor.ts";

describe("doctor", () => {
  test("Honcho prerequisites are required for a ready local Mac/Linux harness", () => {
    expect(
      requiredChecksPassed([
        { name: "Bun", ok: true, required: true },
        { name: "Node compatibility", ok: true, required: true },
        { name: "Git", ok: true, required: true },
        { name: "Postgres psql", ok: false, required: true },
        { name: "pgvector", ok: false, required: true },
        { name: "uv", ok: false, required: true },
      ]),
      "Honcho-backed memory peering is mission-critical, so doctor should fail until the local memory stack is ready.",
    ).toBe(false);
  });

  test("missing core tooling still fails doctor", () => {
    expect(
      requiredChecksPassed([
        { name: "Bun", ok: true, required: true },
        { name: "Node compatibility", ok: true, required: true },
        { name: "Git", ok: false, required: true },
        { name: "Postgres psql", ok: true, required: false },
      ]),
      "Doctor must keep failing when the cross-platform core tooling is missing.",
    ).toBe(false);
  });
});
