/**
 * Account deletion. See policy.ts for the flow and every gate, service.ts for
 * the commands, inventory.ts for what happens to each table, retention.ts for
 * the manual expiry of what deletion keeps.
 */
export * from "./policy.ts";
export * from "./service.ts";
export { previewRetention, executeRetentionSweep, RetentionError, type RetentionItem, type RetentionPreview, type SweepResult } from "./retention.ts";
export { INVENTORY, FENCE_TRIGGER_TABLES, PURGE_ORDER, type TableClass, type Disposition } from "./inventory.ts";
