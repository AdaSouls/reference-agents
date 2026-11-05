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
  /** Where the bytes came from when it differs from anchorUrl (an IPFS gateway). */
  fetchedFrom?: string;
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

// ---------- constitution ----------

export interface ConstitutionSourceRecord {
  hash: string;
  anchorUrl: string;
  fetchedFrom?: string;
  actionKey: string;
  proposalId: string;
  enactedEpoch: number;
  guardrailsScript?: string;
  verifiedAt: string;
  bytes: number;
  sections: number;
  guardrails: number;
  splitter?: number;
}

/**
 * `data/constitution/<anchor hash>/`:
 *   constitution.md   the bytes, exactly as anchored
 *   sections.json     the split (ids analyses cite)
 *   source.json       where it came from and when it was verified
 *   current           (at data/constitution/current) the hash in force
 *
 * A new Constitution is a new directory; old analyses keep pointing at the
 * version they cited.
 */
export class ConstitutionStore {
  constructor(private readonly dataDir: string) {}

  dir(hash: string): string {
    return path.join(this.dataDir, "constitution", hash);
  }

  async save(hash: string, bytes: Uint8Array, split: unknown, source: ConstitutionSourceRecord): Promise<void> {
    await mkdir(this.dir(hash), { recursive: true });
    await writeFile(path.join(this.dir(hash), "constitution.md"), bytes);
    await writeFile(path.join(this.dir(hash), "sections.json"), JSON.stringify(split, null, 2) + "\n");
    await writeFile(path.join(this.dir(hash), "source.json"), JSON.stringify(source, null, 2) + "\n");
    await writeFile(path.join(this.dataDir, "constitution", "current"), hash + "\n");
  }

  async currentHash(): Promise<string | undefined> {
    try {
      return (await readFile(path.join(this.dataDir, "constitution", "current"), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async readSource(hash: string): Promise<ConstitutionSourceRecord | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(hash), "source.json"), "utf8")) as ConstitutionSourceRecord;
    } catch {
      return undefined;
    }
  }

  async readSections<T = unknown>(hash: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(hash), "sections.json"), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async readText(hash: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.dir(hash), "constitution.md"), "utf8");
    } catch {
      return undefined;
    }
  }
}
