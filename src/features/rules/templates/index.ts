import approval from "./always/approval.md?raw";
import dependencies from "./always/dependencies.md?raw";
import injection from "./always/injection.md?raw";
import repo from "./always/repo.md?raw";
import responseStyle from "./always/response-style.md?raw";
import safety from "./always/safety.md?raw";
import secrets from "./always/secrets.md?raw";
import backend from "./scoped/backend.md?raw";
import database from "./scoped/database.md?raw";

export interface RuleSourceFile {
  /** Path relative to the rules directory, for example "always/safety.md". */
  path: string;
  content: string;
}

/** The starting rule sources `init` installs into the project's rules directory. */
export const defaultRuleSources: readonly RuleSourceFile[] = [
  { path: "always/approval.md", content: approval },
  { path: "always/dependencies.md", content: dependencies },
  { path: "always/injection.md", content: injection },
  { path: "always/repo.md", content: repo },
  { path: "always/response-style.md", content: responseStyle },
  { path: "always/safety.md", content: safety },
  { path: "always/secrets.md", content: secrets },
  { path: "scoped/backend.md", content: backend },
  { path: "scoped/database.md", content: database },
];
