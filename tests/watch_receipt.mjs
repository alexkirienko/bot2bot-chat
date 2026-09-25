import assert from 'node:assert/strict';
import { retainUnackedClaim } from '../sdk/watch_receipt.mjs';

const state = { seq: null, claimId: null };
assert.equal(retainUnackedClaim(state, { seq: 101, claim_id: 'first' }), true);
assert.equal(retainUnackedClaim(state, { seq: 101, claim_id: 'rotated' }), false,
  'an expired lease for the same message must not wake the host again');
assert.equal(state.claimId, 'rotated', 'record the fresh receipt for ACK reconciliation');
assert.equal(retainUnackedClaim(state, { seq: 102, claim_id: 'next' }), true,
  'a genuinely newer message must still wake the host');
console.log('✓ watch receipt dedupes redeliveries by seq, not claim ID');
