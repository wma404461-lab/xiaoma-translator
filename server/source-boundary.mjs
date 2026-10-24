// Future words can veto a boundary; they never become translation input.
export function needsContinuation(selected,continuation){
  const source=selected.trim(),next=continuation.trim();
  if(/^(?:with|without|unless|until|except|if|when)\b/i.test(next))return true;
  return (/\bget the ball$/i.test(source)&&/^rolling\b/i.test(next))
    || (/\ba game$/i.test(source)&&/^changer\b/i.test(next))
    || (/\bstart$/i.test(source)&&/^from\b/i.test(next))
    || (/\ba piece$/i.test(source)&&/^of\b/i.test(next))
    || (/\b(?:\d+|fifteen|fifty|thirty|forty)$/i.test(source)&&/^(?:per\s+cent|percent|dollars?|seconds?|minutes?|hours?|years?)\b/i.test(next));
}

// Experimental guard, opt-in for QA until the paced audio comparison passes.
export function needsParticleContinuation(selected,continuation){
  return needsContinuation(selected,continuation)
    || (/\b(?:get|gets|got|getting)$/i.test(selected.trim())&&/^to\b/i.test(continuation.trim()))
    || (/\b(?:wake|wakes|woke|waking)$/i.test(selected.trim())&&/^up\b/i.test(continuation.trim()));
}
