// One press command in the loopback implementation fixture. Enter and Space
// represent normalized keys. Requests exclude the initial page load.
module KeyboardActivation {
  pure val Targets = Set("link-enter", "link-space", "submit-space", "submit-enter",
    "input-submit-space", "ordinary-space", "reset-space", "disabled-space",
    "fieldset-disabled-space", "plain-enter")
  pure def route(target) =
    if (target == "link-enter") "link"
    else if (Set("submit-space", "submit-enter", "input-submit-space").contains(target)) "submit"
    else if (Set("disabled-space", "fieldset-disabled-space").contains(target)) "disabled"
    else if (target == "reset-space") "reset" else "inert"
  var s: { phase: str, target: str, control: str, effect: str,
    requests: int, error: bool, value: str }
  action init = s' = { phase: "idle", target: "plain-enter", control: "inert",
    effect: "none", requests: 0, error: false, value: "original" }
  action selectTarget(target) = all {
    s.phase == "idle", Targets.contains(target),
    s' = { ...s, phase: "selected", target: target,
      value: if (target == "reset-space") "edited" else "original" },
  }
  action choose = { nondet target = Targets.oneOf(); selectTarget(target) }
  action dispatch = all {
    s.phase == "selected", s' = { ...s, phase: "dispatched", control: route(s.target) },
  }
  action complete = all {
    s.phase == "dispatched",
    s' = { ...s, phase: "finished", error: s.control == "disabled",
      value: if (s.control == "reset") "original" else s.value,
      effect: if (s.control == "link") "GET" else if (s.control == "submit") "POST" else "none",
      requests: if (Set("link", "submit").contains(s.control)) 1 else 0 },
  }
  action step = any { choose, dispatch, complete, s' = s }
  val Bounded = Set("idle", "selected", "dispatched", "finished").contains(s.phase)
    and Targets.contains(s.target) and s.requests >= 0 and s.requests <= 1
  val NoEarlyEffect = (s.phase != "finished").implies(s.requests == 0 and not(s.error))
  val CorrectDispatch = Set("dispatched", "finished").contains(s.phase).implies(s.control == route(s.target))
  val CorrectOutcome = (s.phase == "finished").implies(
    s.error == Set("disabled-space", "fieldset-disabled-space").contains(s.target)
    and s.effect == (if (s.target == "link-enter") "GET"
      else if (Set("submit-space", "submit-enter", "input-submit-space").contains(s.target)) "POST" else "none")
    and s.requests == (if (s.effect == "none") 0 else 1) and s.value == "original")
  temporal ActivationProgress = (dispatch.weakFair(s) and complete.weakFair(s)).implies(
    (s.phase == "selected").leadsTo(s.phase == "finished"))

  // Before the change only Enter on the submit button reached form activation.
  action oldDispatch = all { s.phase == "selected",
    s' = { ...s, phase: "dispatched", control: if (s.target == "submit-enter") "submit" else "inert" } }
  run lostEnterTest = init.then(selectTarget("link-enter")).then(oldDispatch).then(complete)
    .expect(not(CorrectOutcome))
  run lostResetTest = init.then(selectTarget("reset-space")).then(oldDispatch).then(complete)
    .expect(not(CorrectOutcome))
  run submitSpaceTest = init.then(selectTarget("submit-space")).then(dispatch).then(complete)
    .expect(CorrectOutcome and s.requests == 1)
  run linkSpaceIsInertTest = init.then(selectTarget("link-space")).then(dispatch).then(complete)
    .expect(CorrectOutcome and s.requests == 0)
}
