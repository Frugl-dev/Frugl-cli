export interface EffectiveLinkPrs {
  active: boolean;
  source: "flag" | "config" | "default";
}

// Precedence (R-7): an explicit `--link-prs` flag wins, else the persisted
// `linkPrs` config, else off. `flagValue` is `undefined` when the flag was not
// passed (the oclif flag has no default), `true` when passed.
export function resolveEffectiveLinkPrs(
  flagValue: boolean | undefined,
  configValue: boolean,
): EffectiveLinkPrs {
  if (flagValue === true) return { active: true, source: "flag" };
  if (configValue === true) return { active: true, source: "config" };
  return { active: false, source: "default" };
}
