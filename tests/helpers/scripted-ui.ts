import type { Choice, Ui } from "../../src/features/commands/ui.ts";

type Answer = string | string[] | boolean | ((prompt: string) => string | string[] | boolean);

/**
 * A Ui for tests. Prompts are answered in order from `answers`; asking more than was scripted is a test
 * failure, which catches commands that prompt when they should not.
 */
export class ScriptedUi implements Ui {
  readonly lines: string[] = [];
  readonly prompts: string[] = [];
  /** The values each select offered, by prompt text. */
  readonly offered: Record<string, string[]> = {};
  private queue: Answer[];

  constructor(
    answers: Answer[] = [],
    readonly interactive = true,
  ) {
    this.queue = [...answers];
  }

  private next(prompt: string): string | string[] | boolean {
    this.prompts.push(prompt);
    const answer = this.queue.shift();
    if (answer === undefined) throw new Error(`Unexpected prompt: ${prompt}`);
    return typeof answer === "function" ? answer(prompt) : answer;
  }

  private log(kind: string, text: string) {
    this.lines.push(`${kind}${text}`);
  }

  get text(): string {
    return this.lines.join("\n");
  }

  intro = (title: string, _options?: { big?: boolean }) => this.log("", `# ${title}`);
  outro = (message: string) => this.log("", `# ${message}`);
  note = (title: string, lines: readonly string[]) => this.log("", `[${title}]\n${lines.join("\n")}`);
  print = (text: string) => this.log("", text);
  info = (message: string) => this.log("", message);
  success = (message: string) => this.log("OK: ", message);
  warn = (message: string) => this.log("WARN: ", message);
  error = (message: string) => this.log("ERROR: ", message);

  async select<T extends string>({ message, choices }: { message: string; choices: readonly Choice<T>[]; initial?: T }): Promise<T> {
    this.offered[message] = choices.map((c) => c.value);
    const answer = this.next(message) as T;
    if (!choices.some((c) => c.value === answer)) throw new Error(`"${answer}" is not a choice for: ${message}`);
    return answer;
  }

  async multiselect<T extends string>({ message, choices }: { message: string; choices: readonly Choice<T>[] }): Promise<T[]> {
    const answer = this.next(message) as T[];
    for (const value of answer) if (!choices.some((c) => c.value === value)) throw new Error(`"${value}" is not a choice for: ${message}`);
    return answer;
  }

  async confirm({ message }: { message: string; initial?: boolean }): Promise<boolean> {
    return this.next(message) as boolean;
  }
}
