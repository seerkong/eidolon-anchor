/**
 * Profile-neutral TaskSpace contracts.
 *
 * This package deliberately contains data and ports only. Domain vocabulary
 * (for example BP delegation/refusal outcomes) belongs to profile packages.
 */
export * from './kernel.js';
export * from './commands.js';
export * from './events.js';
export * from './receipts.js';
export * from './ports.js';
export * from './canonical.js';
