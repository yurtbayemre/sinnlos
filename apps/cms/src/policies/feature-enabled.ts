import { FEATURE_NAMES, type FeatureName } from "@sinnlos/domain";

import { assertSwitchedOn } from "../utils/module-switches";

/**
 * FEATURES_OFF, the feature side (v0.28, M11): the single routes of a
 * switchable feature (read confirmations, training reports, search
 * logging; HANDLER_FEATURE in utils/module-switches.ts) answer 404 while it
 * is off, whoever calls. A config without a known feature refuses.
 */
export default (_policyContext: unknown, config?: { feature?: unknown }): boolean => {
  const feature = config?.feature;
  if (!FEATURE_NAMES.includes(feature as FeatureName)) return false;
  assertSwitchedOn(feature as FeatureName);
  return true;
};
