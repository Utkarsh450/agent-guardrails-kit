import * as clack from "@clack/prompts";
import pc from "picocolors";
import pkg from "../../../package.json" with { type: "json" };
import { bigBanner } from "./banner.ts";
import { CancelledError } from "./errors.ts";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Everything a command says or asks goes through this interface. The real one draws prompts in the terminal;
 * tests pass a scripted one, so every command can be run without a person.
 */
export interface Ui {
  /** True when a person can answer prompts (stdin and stdout are terminals). */
  readonly interactive: boolean;
  /** `big` draws the large block-letter banner first (only in a real terminal; otherwise it is ignored). */
  intro(title: string, options?: { big?: boolean }): void;
  outro(message: string): void;
  /** A boxed block with a title (used for steps the person has to do). */
  note(title: string, lines: readonly string[]): void;
  /** Plain output (for reports a script might read). */
  print(text: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  select<T extends string>(options: { message: string; choices: readonly Choice<T>[]; initial?: T }): Promise<T>;
  multiselect<T extends string>(options: { message: string; choices: readonly Choice<T>[]; initial?: readonly T[]; required?: boolean }): Promise<T[]>;
  confirm(options: { message: string; initial?: boolean }): Promise<boolean>;
}

function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as T;
}

export function terminalUi(): Ui {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const colour = process.stdout.isTTY === true;
  const paint = (fn: (text: string) => string, text: string) => (colour ? fn(text) : text);

  return {
    interactive,
    // The package name and version come first, so it is always clear which tool is running.
    intro: (title, options) => {
      const banner = `${pkg.name} v${pkg.version} · ${title}`;
      if (interactive && options?.big) process.stdout.write(`${bigBanner({ colour, columns: process.stdout.columns ?? 80 })}\n`);
      if (interactive) clack.intro(paint(pc.bgCyan, ` ${banner} `));
      else process.stdout.write(`${banner}\n`);
    },
    outro: (message) => (interactive ? clack.outro(message) : process.stdout.write(`${message}\n`)),
    note: (title, lines) => (interactive ? clack.note(lines.join("\n"), title) : process.stdout.write(`${title}:\n${lines.map((l) => `  ${l}`).join("\n")}\n`)),
    print: (text) => process.stdout.write(`${text}\n`),
    info: (message) => (interactive ? clack.log.info(message) : process.stdout.write(`${message}\n`)),
    success: (message) => (interactive ? clack.log.success(message) : process.stdout.write(`${message}\n`)),
    warn: (message) => (interactive ? clack.log.warn(message) : process.stderr.write(`warning: ${message}\n`)),
    error: (message) => (interactive ? clack.log.error(message) : process.stderr.write(`error: ${message}\n`)),

    async select({ message, choices, initial }) {
      const options = choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) }));
      const answer = await clack.select({ message, options: options as never, ...(initial ? { initialValue: initial } : {}) });
      return unwrap(answer) as never;
    },
    async multiselect({ message, choices, initial, required = true }) {
      const options = choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) }));
      const answer = await clack.multiselect({ message, options: options as never, required, ...(initial ? { initialValues: [...initial] as never } : {}) });
      return unwrap(answer) as never;
    },
    async confirm({ message, initial = true }) {
      const answer = await clack.confirm({ message, initialValue: initial });
      return unwrap<boolean>(answer);
    },
  };
}
