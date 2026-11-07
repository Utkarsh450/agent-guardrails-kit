import {
  DEPENDENCY_SECTIONS,
  INSTALL_SCRIPTS,
  LOCKFILES,
  POPULAR_PACKAGES,
  dependencyFindings,
  diffDependencies,
  editDistance,
  typosquatSuspect,
  unusualSpec,
  type DependencyDiff,
} from "../git/git-checks/git-checks.mjs";

/** The dependency checks, shared with the git hooks and CI. The agent-facing rule is rules/templates/always/dependencies.md. */
export {
  DEPENDENCY_SECTIONS,
  INSTALL_SCRIPTS,
  LOCKFILES,
  POPULAR_PACKAGES,
  dependencyFindings,
  diffDependencies,
  editDistance,
  typosquatSuspect,
  unusualSpec,
  type DependencyDiff,
};
