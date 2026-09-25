// An expired server lease may rotate claim_id without creating a new message.
// Keep the newest receipt for ACK, but wake the native host only for a new seq.
export function retainUnackedClaim(state, { seq, claim_id }) {
  const nextSeq = Number(seq);
  const shouldNotify = state.seq !== nextSeq;
  state.seq = nextSeq;
  state.claimId = claim_id;
  return shouldNotify;
}
