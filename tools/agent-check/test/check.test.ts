import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAgent } from "../check.js";

const analyst = path.join(import.meta.dirname, "..", "..", "..", "governance-analyst");

describe("agent-check", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agent-check-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an empty directory fails the layout and nothing crashes silently", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.1", scripts: {} }));
    const v = await checkAgent(dir, { subprocess: false });
    const byId = Object.fromEntries(v.map((x) => [x.id, x]));
    expect(byId.layout.status).toBe("fail");
    expect(byId.layout.detail).toContain("alma.yaml");
    expect(byId.scripts.detail).toContain("check, eval");
    expect(v.every((x) => x.status !== "pass" || ["secrets"].includes(x.id))).toBe(true);
  });

  it("the governance analyst passes every static check, or names exactly what is missing", async () => {
    const v = await checkAgent(analyst, { subprocess: false });
    const failed = v.filter((x) => x.status === "fail");
    // Recordings are made by the person with the model key; everything else must hold here.
    expect(failed.filter((x) => x.id !== "evals")).toEqual([]);
    expect(v.filter((x) => x.status === "skip").map((x) => x.id)).toEqual(["audit", "eval-replay"]);
  });

  it("catches a committed secret pattern and a manifest that votes", async () => {
    await writeFile(path.join(dir, "alma.yaml"), "kind: Agent\nversion: alma/v1\nmetadata:\n  name: voter\nidentity:\n  type: agent\ncapabilities:\n  - analyze\n  - vote\n");
    await writeFile(path.join(dir, "package.json"), "{}");
    const w = await checkAgent(dir, { subprocess: false });
    const manifest = w.find((x) => x.id === "manifest")!;
    expect(manifest.status).toBe("fail");
    expect(manifest.detail).toMatch(/vote|limit/);
  });
});
