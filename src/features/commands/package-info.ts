import pkg from "../../../package.json" with { type: "json" };

/**
 * The published package, when this CLI came from npm. A development build (version 0.0.0) is not published, so
 * the CI workflow it writes must not try to download it: the doctor step is only added for a real release.
 */
export function publishedPackage(info: { name: string; version: string } = pkg): { packageName: string; version: string } | undefined {
  return info.version === "0.0.0" ? undefined : { packageName: info.name, version: info.version };
}
