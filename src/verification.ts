/** Observation after an action; never permission to repeat that action. */
export type Verification = {
  status: 'verified' | 'not_observed' | 'unavailable' | 'not_applicable';
  method: 'gmail.sent-message' | 'filesystem.readback' | 'dry-run';
  checkedAt: string;
  reason?: string;
  observed?: number;
};
