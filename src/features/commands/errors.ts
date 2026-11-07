/** A problem the person can fix (bad flag, missing settings, a file we will not touch). Printed without a stack trace. */
export class CliError extends Error {
  override name = "CliError";
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** The person pressed Ctrl+C or chose to stop at a prompt. Nothing was changed. */
export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("Cancelled. Nothing was changed.");
  }
}
