// Transient per-service state: index -> 'starting' | 'stopping'.
// Used to label the dashboard and disable buttons while an action is in flight.
export const serviceState = new Map();
