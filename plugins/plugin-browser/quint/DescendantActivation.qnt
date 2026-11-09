// One web-mode click in the loopback fixture used by implementation conformance.
// Requests count effects after the initial page load. Network completion is an
// environment assumption; this model does not claim to model the transport.
module DescendantActivation {
  pure val Targets = Set("link", "link-nested", "link-svg", "submit",
    "submit-nested", "submit-svg", "disabled", "disabled-fieldset", "plain")
  pure def owner(target) =
    if (Set("link", "link-nested", "link-svg").contains(target)) "link"
    else if (Set("submit", "submit-nested", "submit-svg").contains(target)) "submit"
    else if (Set("disabled", "disabled-fieldset").contains(target)) "disabled"
    else "none"
  var s: { phase: str, target: str, control: str, effect: str, requests: int, error: bool }
  action init = s' = { phase: "idle", target: "plain", control: "none",
    effect: "none", requests: 0, error: false }
  action selectTarget(target) = all {
    s.phase == "idle", Targets.contains(target),
    s' = { ...s, phase: "selected", target: target },
  }
  action choose = { nondet target = Targets.oneOf(); selectTarget(target) }
  action resolve = all {
    s.phase == "selected",
    s' = { ...s, phase: "resolved", control: owner(s.target) },
  }
  action complete = all {
    s.phase == "resolved",
    s' = { ...s, phase: "finished", error: s.control == "disabled",
      effect: if (s.control == "link") "GET" else if (s.control == "submit") "POST" else "none",
      requests: if (Set("link", "submit").contains(s.control)) 1 else 0 },
  }
  action step = any { choose, resolve, complete, s' = s }
  val Bounded = Set("idle", "selected", "resolved", "finished").contains(s.phase)
    and Targets.contains(s.target) and s.requests >= 0 and s.requests <= 1
  val NoEarlyEffect = (s.phase != "finished").implies(s.requests == 0 and not(s.error))
  val CorrectOwner = Set("resolved", "finished").contains(s.phase).implies(s.control == owner(s.target))
  val CorrectOutcome = (s.phase == "finished").implies(
    s.error == Set("disabled", "disabled-fieldset").contains(s.target)
    and s.effect == (if (Set("link", "link-nested", "link-svg").contains(s.target)) "GET"
      else if (Set("submit", "submit-nested", "submit-svg").contains(s.target)) "POST" else "none")
    and s.requests == (if (s.effect == "none") 0 else 1))
  temporal ActivationProgress = (resolve.weakFair(s) and complete.weakFair(s)).implies(
    (s.phase == "selected").leadsTo(s.phase == "finished"))

  // The old implementation treated the selected descendant as an inert element.
  action oldResolve = all { s.phase == "selected", s' = { ...s, phase: "resolved" } }
  run lostLinkTest = init.then(selectTarget("link-svg")).then(oldResolve).then(complete)
    .expect(not(CorrectOutcome))
  run lostDisabledCheckTest = init.then(selectTarget("disabled-fieldset")).then(oldResolve).then(complete)
    .expect(not(CorrectOutcome))
  run nestedSubmitTest = init.then(selectTarget("submit-nested")).then(resolve).then(complete)
    .expect(CorrectOwner and CorrectOutcome and s.requests == 1)
  run inertTextTest = init.then(selectTarget("plain")).then(resolve).then(complete)
    .expect(CorrectOutcome and s.requests == 0)
}
