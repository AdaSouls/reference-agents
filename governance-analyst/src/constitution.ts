import { z } from "zod";
import type { Proposal } from "./koios.js";

/**
 * G1.2: the Cardano Constitution, verified, split into sections with
 * stable ids that analyses can cite.
 *
 * Where it comes from: the chain. The current Constitution is the anchor
 * named by the latest *enacted* `NewConstitution` governance action (the
 * first one, enacted in epoch 542, set the 2025 Constitution; later
 * amendments replace it). We never trust a copy by its filename: the bytes
 * must hash to that anchor's `dataHash`.
 *
 * Ids follow the document's own numbering, never line numbers, so they
 * survive re-wrapping and survive between versions where the structure is
 * unchanged:
 *
 *   preamble, defined-terms
 *   art-1, art-1-sec-2            ARTICLE II / Section 2
 *   app-1, app-1-s2, app-1-s2-1   APPENDIX I / 2. / 2.1.
 *   app-1-s2-1-<slug>             deeper headings, by slug of their title
 *   PARAM-01, TFPB-02a            individual guardrails, by their own label
 */

export interface ConstitutionAnchor {
  url: string;
  hash: string;
  /** `<tx>-<ix>` of the NewConstitution action that enacted it. */
  actionKey: string;
  proposalId: string;
  enactedEpoch: number;
  /** Hash of the guardrails script the action names, when present. */
  guardrailsScript?: string;
}

const newConstitutionDescription = z.object({
  tag: z.literal("NewConstitution"),
  contents: z.tuple([
    z.unknown(),
    z.object({
      anchor: z.object({ url: z.string().min(1), dataHash: z.string().regex(/^[0-9a-f]{64}$/) }),
      script: z.string().nullable().optional(),
    }),
  ]),
});

/** The anchor of the Constitution in force: the latest enacted NewConstitution action. */
export function currentConstitutionAnchor(proposals: Proposal[]): ConstitutionAnchor | undefined {
  const enacted = proposals
    .filter((p) => p.proposal_type === "NewConstitution" && p.enacted_epoch != null)
    .sort((a, b) => (b.enacted_epoch ?? 0) - (a.enacted_epoch ?? 0));
  for (const p of enacted) {
    const parsed = newConstitutionDescription.safeParse(p.proposal_description);
    if (!parsed.success) continue;
    const { anchor, script } = parsed.data.contents[1];
    return {
      url: anchor.url,
      hash: anchor.dataHash.toLowerCase(),
      actionKey: `${p.proposal_tx_hash}-${p.proposal_index}`,
      proposalId: p.proposal_id,
      enactedEpoch: p.enacted_epoch!,
      guardrailsScript: script ?? undefined,
    };
  }
  return undefined;
}

// ---------- splitting ----------

export interface Section {
  id: string;
  title: string;
  /** 0 = part (preamble, article, appendix); 1 = Section / "N."; 2 = "N.M."; 3+ = unnumbered sub-headings by depth. */
  level: number;
  parent?: string;
  /** 1-based, inclusive, in the source text. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface Guardrail {
  /** The label as printed, e.g. "PARAM-02a". */
  id: string;
  /** Section id it sits under. */
  section: string;
  checkable: boolean;
  startLine: number;
  text: string;
}

export interface SplitConstitution {
  sections: Section[];
  guardrails: Guardrail[];
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/["'“”‘’(),.:;]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

const stripBold = (s: string) => s.replace(/^\*\*(.*)\*\*$/, "$1").trim();

interface Heading {
  line: number;
  level: number;
  id: string;
  title: string;
}

/** Recognise the document's heading forms and give each a stable id. */
function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let part: { kind: "preamble" | "terms" | "art" | "app" | "other"; id: string } | undefined;
  let lastAtLevel: Record<number, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    // Setext heading: **TITLE** followed by ---- or ====
    if (/^\*\*.+\*\*\s*$/.test(line) && /^(-{3,}|={3,})\s*$/.test(next)) {
      const title = stripBold(line);
      const art = /^ARTICLE\s+([IVX]+)\b/i.exec(title);
      const app = /^APPENDIX\s+([IVX]+)\b/i.exec(title);
      let id: string;
      if (/^PREAMBLE/i.test(title)) {
        id = "preamble";
        part = { kind: "preamble", id };
      } else if (/^DEFINED TERMS/i.test(title)) {
        id = "defined-terms";
        part = { kind: "terms", id };
      } else if (art) {
        id = `art-${ROMAN[art[1].toUpperCase()] ?? art[1].toLowerCase()}`;
        part = { kind: "art", id };
      } else if (app) {
        id = `app-${ROMAN[app[1].toUpperCase()] ?? app[1].toLowerCase()}`;
        part = { kind: "app", id };
      } else if (/CONSTITUTION\s*$/i.test(title) && out.length === 0) {
        continue; // the document title
      } else {
        id = slug(title);
        part = { kind: "other", id };
      }
      lastAtLevel = { 0: id };
      out.push({ line: i + 1, level: 0, id, title });
      i += 1;
      continue;
    }
    // ATX headings: ### **Section 1 Title** / ### **2.1. Title** / #### **Title**
    const atx = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (atx && part) {
      const hashes = atx[1].length; // ### = 3
      const title = stripBold(atx[2]);
      let id: string | undefined;
      let level: number;
      const sec = /^Section\s+(\d+)\b/i.exec(title);
      const num = /^(\d+(?:\.\d+)*)\.?\s+/.exec(title);
      if (part.kind === "art" && sec) {
        id = `${part.id}-sec-${sec[1]}`;
        level = 1;
      } else if (part.kind === "app" && num && hashes === 3) {
        id = `${part.id}-s${num[1].replace(/\./g, "-")}`;
        level = num[1].split(".").length; // 2. -> 1, 2.1. -> 2
      } else {
        // Unnumbered headings nest by depth: #### -> 3, ##### -> 4, under the
        // nearest numbered or unnumbered heading above them.
        level = hashes;
        let parentId = part.id;
        for (let k = level - 1; k >= 1; k--) {
          if (lastAtLevel[k]) {
            parentId = lastAtLevel[k];
            break;
          }
        }
        id = `${parentId}-${slug(title)}`;
      }
      // Disambiguate repeated titles under the same parent (e.g. several "GUARDRAILS").
      if (out.some((h) => h.id === id)) {
        let n = 2;
        while (out.some((h) => h.id === `${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      lastAtLevel[level] = id;
      for (const k of Object.keys(lastAtLevel)) if (Number(k) > level) delete lastAtLevel[Number(k)];
      out.push({ line: i + 1, level, id, title });
    }
  }
  return out;
}

const GUARDRAIL_RE = /^([A-Z]{2,6}-\d{2}[a-z]?)\s+(\((?:y|x|~)\))?\s*(.*)$/;

export function splitConstitution(text: string): SplitConstitution {
  const lines = text.split(/\r?\n/);
  const hs = headings(lines);
  const sections: Section[] = hs.map((h, idx) => {
    // A section runs until the next heading of the same or a shallower level.
    let end = lines.length;
    for (let j = idx + 1; j < hs.length; j++) {
      if (hs[j].level <= h.level) {
        end = hs[j].line - 1;
        break;
      }
    }
    // Trim trailing blank lines.
    while (end > h.line && lines[end - 1].trim() === "") end--;
    // Parent: nearest previous heading with a shallower level.
    let parent: string | undefined;
    for (let j = idx - 1; j >= 0; j--) {
      if (hs[j].level < h.level) {
        parent = hs[j].id;
        break;
      }
    }
    return { id: h.id, title: h.title, level: h.level, parent, startLine: h.line, endLine: end, text: lines.slice(h.line - 1, end).join("\n") };
  });

  // Guardrails: a label at the start of a line, running to the next blank line.
  const guardrails: Guardrail[] = [];
  const deepest = (lineNo: number) => {
    let best: Section | undefined;
    for (const s of sections) if (s.startLine <= lineNo && lineNo <= s.endLine && (!best || s.level >= best.level)) best = s;
    return best?.id ?? "";
  };
  for (let i = 0; i < lines.length; i++) {
    const m = GUARDRAIL_RE.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !GUARDRAIL_RE.test(lines[j])) j++;
    guardrails.push({
      id: m[1],
      section: deepest(i + 1),
      checkable: m[2] === "(y)",
      startLine: i + 1,
      text: lines.slice(i, j).join("\n"),
    });
  }
  return { sections, guardrails };
}

/** A section or guardrail by id, for citation checks (test plan gate 5). */
export function findCitable(split: SplitConstitution, id: string): Section | Guardrail | undefined {
  return split.sections.find((s) => s.id === id) ?? split.guardrails.find((g) => g.id === id);
}
