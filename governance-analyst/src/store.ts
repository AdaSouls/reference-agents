import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnchorCheck } from "./anchor.js";
import type { Proposal } from "./koios.js";

/**
 * `data/actions/<tx>-<ix>/`:
 *   onchain.json    the Koios record, as received
 *   anchor.bin      the anchor bytes, when something was downloaded (verified or not)
 *   check.json      the verdict, with when it was taken
 *
 * Files, not a database: the directory is the evidence trail a reviewer
 * opens, and `votes/` in cardano-governance mirrors its keys.
 */

export interface ActionCheckRecord {
  key: string;
  proposalId: string;
  checkedAt: string;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchor: AnchorCheck;
  contentType?: string;
}

export class ActionStore {
  constructor(private readonly dataDir: string) {}

  dir(key: string): string {
    return path.join(this.dataDir, "actions", key);
  }

  async saveOnchain(key: string, proposal: Proposal): Promise<void> {
    await mkdir(this.dir(key), { recursive: true });
    await writeFile(path.join(this.dir(key), "onchain.json"), JSON.stringify(proposal, null, 2) + "\n");
  }

  async saveAnchor(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir(key), { recursive: true });
    await writeFile(path.join(this.dir(key), "anchor.bin"), bytes);
  }

  async saveCheck(key: string, record: ActionCheckRecord): Promise<void> {
    await mkdir(this.dir(key), { recursive: true });
    await writeFile(path.join(this.dir(key), "check.json"), JSON.stringify(record, null, 2) + "\n");
  }

  async readCheck(key: string): Promise<ActionCheckRecord | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(key), "check.json"), "utf8")) as ActionCheckRecord;
    } catch {
      return undefined;
    }
  }

  async readOnchain(key: string): Promise<Proposal | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(key), "onchain.json"), "utf8")) as Proposal;
    } catch {
      return undefined;
    }
  }

  async keys(): Promise<string[]> {
    try {
      return (await readdir(path.join(this.dataDir, "actions"))).sort();
    } catch {
      return [];
    }
  }
}
