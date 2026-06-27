// Re-export the health store's Overall type so HealthPill can find it
// at its original import path.

export type { HealthOverall as Overall } from "$lib/stores/health.svelte";
