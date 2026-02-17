/**
 * ACL barrel export — re-exports from focused acl/ modules.
 *
 * This file exists for backward compatibility with index.ts, index-sse.ts, and tools/registry.ts.
 * All logic lives in acl/ submodules.
 */

// Types
export type { AclConfig, AclCheckResult } from "./acl/types.js";

// Config loading
export { loadAclConfig, reloadAclConfig } from "./acl/config.js";

// Email resolution
export { resolveUserEmail } from "./acl/email-resolver.js";

// User ACL cache
export { resolveUserAcls, clearAclCache, getAclCacheStats } from "./acl/user-cache.js";

// Access evaluation
export { checkToolAccess, filterToolsByAccess } from "./acl/evaluator.js";
