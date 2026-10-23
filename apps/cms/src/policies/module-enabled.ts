import { MODULE_NAMES, type ModuleName } from "@sinnlos/domain";

import { assertSwitchedOn } from "../utils/module-switches";

/**
 * FEATURES_OFF, the module side (v0.28, S2): every route of a module's APIs
 * carries this policy in front of its own (utils/module-switches.ts puts it
 * there at register()). While the module is off the route answers 404,
 * whoever calls; on, it passes without reading anything. A config without
 * a known module refuses (fail closed).
 */
export default (_policyContext: unknown, config?: { module?: unknown }): boolean => {
  const module = config?.module;
  if (!MODULE_NAMES.includes(module as ModuleName)) return false;
  assertSwitchedOn(module as ModuleName);
  return true;
};
