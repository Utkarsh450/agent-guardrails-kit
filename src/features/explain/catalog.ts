export type Kind = "blocked" | "asks" | "info";

export interface RuleInfo {
  /** Short name shown in reports. */
  title: string;
  kind: Kind;
  /** Why the guard does this, in plain words. */
  why: string;
  /** What to do instead (or how to allow it on purpose). */
  instead: string;
}

const RUN_YOURSELF = "Run it yourself in your own terminal, or tell the agent exactly why it is needed and let it ask you in chat.";

/** One entry for every rule id the guard can return. A test keeps this complete. */
export const RULES: Record<string, RuleInfo> = {
  allowed: { title: "Allowed", kind: "info", why: "The action is known to be harmless (for example reading a file or git status).", instead: "Nothing to do." },
  watched: { title: "Let through by watch mode", kind: "info", why: "Watch mode is on, so an action the guard would normally ask about ran without asking and was logged. Blocked actions are still blocked, and watch mode ends by itself on the date in watchUntil.", instead: "Run `agent-guardrails mode enforce` to switch asking back on, or `agent-guardrails report` to see what it let through." },
  "user-allowed": { title: "Allowed by you", kind: "info", why: "The command matches an entry in allowCommands in agent-guardrails.config.json, so it runs without asking.", instead: "Remove the entry (agent-guardrails allow remove) to be asked again." },
  "unknown-command": { title: "Unknown command", kind: "asks", why: "The guard does not recognise this command, so you decide. Agents cannot judge their own commands.", instead: "Approve it once, or run `agent-guardrails allow add \"<command>\"` so it never asks again." },
  "not-allowed": { title: "Not on the allow list", kind: "blocked", why: "The settings use policy \"allowlist\": only commands in allowCommands may run.", instead: "Add the command with `agent-guardrails allow add`, or switch policy to \"ask\"." },
  "file-deletion": { title: "Deleting files", kind: "blocked", why: "Deleted files cannot be recovered by the guard, and agents delete too much when they are wrong.", instead: RUN_YOURSELF },
  "file-write": { title: "Overwriting files or devices", kind: "blocked", why: "dd, find -fprint and similar commands overwrite files or disks.", instead: RUN_YOURSELF },
  "git-write": { title: "Changing git", kind: "blocked", why: "Agents may only read git (status, diff, log, show). You run everything that changes history, branches or remotes.", instead: "Run the git command yourself. To allow more read-only commands, add them to gitAllow (the team preset does)." },
  "git-option": { title: "Risky git option", kind: "blocked", why: "Options like -c, -C or --output can make git run other programs or write files.", instead: "Run it without the option, or run it yourself." },
  "github-cli": { title: "GitHub CLI", kind: "blocked", why: "gh can create, merge and delete things on GitHub and use your logged-in account.", instead: RUN_YOURSELF },
  publish: { title: "Publishing or logging in", kind: "blocked", why: "Publishing sends code to a public registry and cannot be undone.", instead: "Run the publish command yourself." },
  "process-kill": { title: "Stopping processes", kind: "blocked", why: "Killing a process can stop your database, your editor or this very session.", instead: "Stop it yourself, or tell the agent which process and why." },
  "privilege-escalation": { title: "Running as administrator", kind: "blocked", why: "sudo, su and similar give a command full control of the machine.", instead: RUN_YOURSELF },
  "recursive-permissions": { title: "Changing permissions of a whole tree", kind: "blocked", why: "chmod -R and chown -R can break or open up every file in a folder.", instead: "Change the specific files you need." },
  "infra-delete": { title: "Deleting cloud or container resources", kind: "blocked", why: "Commands like docker rm, kubectl delete or terraform destroy remove real infrastructure.", instead: RUN_YOURSELF },
  "data-delete": { title: "Deleting database data", kind: "blocked", why: "DELETE, DROP, TRUNCATE and database reset commands destroy data.", instead: "Run the statement yourself against the right database." },
  "destructive-sql-file": { title: "Destructive SQL in a file", kind: "blocked", why: "A migration or .sql file containing DROP, TRUNCATE or DELETE would destroy data when someone runs it.", instead: "Describe the change to the agent and write the destructive statement yourself." },
  "db-client": { title: "Database command", kind: "asks", why: "A database client can change data, and the guard cannot see what a script file will do.", instead: "Approve it if it only reads, or run it yourself." },
  "pipe-to-shell": { title: "Piping text into a shell", kind: "blocked", why: "curl ... | sh and similar run code nobody reviewed.", instead: "Download the file, read it, then run it yourself." },
  "obfuscated-exec": { title: "Hidden command", kind: "blocked", why: "Decoding text and piping it into a shell hides what will run.", instead: "Write the real command out in plain text." },
  "inline-code-exec": { title: "Code that starts other programs", kind: "blocked", why: "Inline python -c or node -e code that runs other programs gets around the command checks.", instead: "Put the code in a file, review it, and run it yourself." },
  "inline-code": { title: "Inline script", kind: "asks", why: "The guard only looks for known-dangerous calls in python -c / node -e code, so you approve the rest.", instead: "Approve it if you read it and it is fine." },
  "script-exec": { title: "Running a script file", kind: "asks", why: "The guard cannot see what a shell script or sourced file does.", instead: "Read the script, then approve it or run it yourself." },
  "runs-command": { title: "Command that runs another command", kind: "asks", why: "Tools like watch, ssh or tmux run a second command the guard cannot inspect. Allowing them in allowCommands does not help.", instead: "Run the inner command directly, or approve this one." },
  "runs-package": { title: "Downloads and runs a package", kind: "asks", why: "npx, bunx and pnpm dlx run code downloaded from a registry.", instead: "Install the package deliberately first, or approve this run after checking the name." },
  "dependency-change": { title: "Changing dependencies", kind: "asks", why: "Adding or updating packages changes what runs on your machine. Agents sometimes invent or misspell package names.", instead: "Check the exact package name first, then approve." },
  "config-change": { title: "Changing package manager settings", kind: "asks", why: "Settings like registries and script shells change how every install behaves.", instead: "Make the change yourself." },
  "package-script": { title: "A package script would be blocked", kind: "blocked", why: "The script you ran (or one of its pre/post/install steps) contains a command the guard blocks, such as rm -rf.", instead: "Look at the script in package.json and run it yourself if it is what you want." },
  "script-scan": { title: "Script would be blocked", kind: "blocked", why: "The guard reads a script file just before it runs. This one contains something the guard blocks when typed directly: deleting files, dropping database data, or touching guardrail files.", instead: "Read the script, then run it yourself if it is what you want. The scan only checks patterns: imports are not followed, so a clean script is not proof that it is safe." },
  "lifecycle-script": { title: "Dangerous install script", kind: "blocked", why: "preinstall, postinstall and prepare scripts that delete files or download code run on every install.", instead: "Remove the script, or add it yourself if you have reviewed it." },
  "risky-env": { title: "Changing an important environment variable", kind: "blocked", why: "Variables like PATH, GIT_* and PAGER can make other programs run code you did not review.", instead: "Set it yourself in your shell if you need it." },
  "outside-project": { title: "Outside the project folder", kind: "blocked", why: "Agents may only read and write inside this folder. Your other files are off limits.", instead: "Copy what is needed into the project, or run the command yourself." },
  "secret-file": { title: "Secret or credentials file", kind: "blocked", why: "Agents must not read or change .env files, private keys or tokens, and a recursive search could print their contents.", instead: "Use .env.example for variable names. For searches, exclude secrets: --exclude='.env*' or rg -g '!.env*'." },
  "protected-path": { title: "Guardrail file", kind: "blocked", why: "The hooks, git hooks, guard script, settings and agent config files are what keep agents in check. Agents cannot edit them.", instead: "Edit the file yourself (or use `agent-guardrails update` / `allow`)." },
  "protected-file": { title: "Rules or workflow file", kind: "asks", why: "Rule files, generated agent files and CI workflows change how agents and builds behave, so you approve each change.", instead: "Approve the change if you read it." },
  "guardrails-cli": { title: "Changing the guardrails themselves", kind: "blocked", why: "agent-guardrails init, update, sync, approve, allow, preset, mode, alerts, restore and ui change the approval record, the allowed commands and the guardrail files, overwrite project files, open a local server or run until stopped. An agent must not approve its own plan or widen its own permissions.", instead: "Run it yourself in your own terminal. Read-only commands (doctor, explain, report, test) are fine." },
  "no-approved-plan": { title: "No approved plan", kind: "blocked", why: "Agents may not create or change files until you have approved a plan (PLAN.md). Editing the plan afterwards cancels the approval.", instead: "Ask the agent to write PLAN.md, read it, then run `agent-guardrails approve`." },
  "mcp-action": { title: "MCP tool that changes something", kind: "asks", why: "The guard cannot inspect MCP tools, so any whose name sounds like an action (create, delete, send...) asks you.", instead: "Approve it if you know what the tool does." },
  "dynamic-command": { title: "Command built from variables", kind: "asks", why: "The command name is built from a variable, wildcard or substitution, so it cannot be checked.", instead: "Ask the agent to write the real command out." },
  "dynamic-path": { title: "Path built from variables", kind: "asks", why: "An argument like $DIR could point anywhere, including outside the project or at a secret.", instead: "Ask the agent to use the literal path." },
  unanalyzable: { title: "Command too complex to check", kind: "asks", why: "The command uses shell syntax the guard cannot read safely (unclosed quotes, odd nesting).", instead: "Ask the agent to simplify it or split it up." },
  "too-deep": { title: "Command nested too deeply", kind: "asks", why: "Wrappers inside wrappers inside wrappers cannot be checked.", instead: "Ask the agent to run the real command directly." },
  "env-dump": { title: "Printing the environment", kind: "asks", why: "env and printenv print every variable, which often includes secrets.", instead: "Ask for the one variable you need." },
  "patch-unreadable": { title: "Patch could not be read", kind: "asks", why: "The guard could not see which files the patch changes.", instead: "Ask the agent to edit files one at a time." },
  "bad-config": { title: "Broken settings file", kind: "blocked", why: "agent-guardrails.config.json is invalid, so the guard blocks everything rather than guess.", instead: "Fix the file (run `agent-guardrails doctor` to see what is wrong)." },
  "guard-error": { title: "The guard crashed", kind: "blocked", why: "If the guard itself breaks, it blocks instead of letting actions through (fail closed).", instead: "Run `agent-guardrails doctor`; check that Node works and `agent-guardrails update` restores the guard." },
  "empty-input": { title: "Guard got no input", kind: "blocked", why: "A hook call with no information cannot be judged, so it is blocked.", instead: "Run `agent-guardrails doctor`; the hook configuration may be wrong." },
  "invalid-input": { title: "Guard got unreadable input", kind: "blocked", why: "The hook input was not valid JSON, so it is blocked.", instead: "Run `agent-guardrails doctor`; the agent may be too new or too old for the hook format." },
  "unrecognized-input": { title: "Guard did not understand the request", kind: "blocked", why: "The tool call had a shape the guard does not know, so it is blocked rather than guessed.", instead: "Run `agent-guardrails doctor` and `agent-guardrails update`; report it if it keeps happening." },
};

export function ruleInfo(id: string): RuleInfo | undefined {
  return RULES[id];
}
