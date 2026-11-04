import Anthropic from "@anthropic-ai/sdk";

/**
 * The one place the model is called. Injectable so tests never touch the
 * network. The key comes from ANTHROPIC_API_KEY (SDK default) and is
 * never read, printed or logged by this code.
 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Completer {
  readonly model: string;
  /** `history` holds earlier turns of the same exchange (a rejected answer and the reason), oldest first. */
  complete(system: string, user: string, maxTokens?: number, history?: Turn[]): Promise<string>;
}

export function anthropicCompleter(model: string): Completer {
  const client = new Anthropic();
  return {
    model,
    async complete(system, user, maxTokens = 8000, history = []) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }, ...history],
      });
      return res.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    },
  };
}
