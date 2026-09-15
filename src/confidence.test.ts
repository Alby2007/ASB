import assert from "node:assert/strict";
import test from "node:test";
import { calculateInitialConfidence, updateConfidence, calculateDefaultImportance, calculateDefaultExplicitness } from "./confidence.js";

test("calculateInitialConfidence returns deterministic values based on evidence type", () => {
  assert.equal(calculateInitialConfidence("explicit_fact"), 0.60);
  assert.equal(calculateInitialConfidence("clear_preference"), 0.60);
  assert.equal(calculateInitialConfidence("direct_observation"), 0.45);
  assert.equal(calculateInitialConfidence("reported_by_other"), 0.35);
  assert.equal(calculateInitialConfidence("correction"), 0.80);
  assert.equal(calculateInitialConfidence("sarcasm_or_joke"), 0.10);
  assert.equal(calculateInitialConfidence("uncertain_inference"), 0.20);
});

test("calculateInitialConfidence is consistent across multiple calls", () => {
  const evidenceType = "explicit_fact";
  const first = calculateInitialConfidence(evidenceType);
  const second = calculateInitialConfidence(evidenceType);
  const third = calculateInitialConfidence(evidenceType);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(first, 0.60);
});

test("updateConfidence increases confidence for support effect with bounded formula", () => {
  assert.equal(updateConfidence(0.50, "support"), 0.525);
  assert.equal(updateConfidence(0.80, "support"), 0.81);
  assert.equal(updateConfidence(0.94, "support"), 0.943);
  assert.equal(updateConfidence(0.96, "support"), 0.95);
});

test("updateConfidence halves confidence for contradict effect", () => {
  assert.equal(updateConfidence(0.80, "contradict"), 0.40);
  assert.equal(updateConfidence(0.50, "contradict"), 0.25);
  assert.equal(updateConfidence(0.10, "contradict"), 0.05);
});

test("updateConfidence preserves confidence for correct and context effects", () => {
  assert.equal(updateConfidence(0.75, "correct"), 0.75);
  assert.equal(updateConfidence(0.75, "context"), 0.75);
});

test("calculateDefaultImportance returns appropriate values for memory kinds", () => {
  assert.equal(calculateDefaultImportance("person_fact"), 0.5);
  assert.equal(calculateDefaultImportance("person_preference"), 0.6);
  assert.equal(calculateDefaultImportance("server_lore"), 0.7);
  assert.equal(calculateDefaultImportance("episode"), 0.4);
});

test("calculateDefaultExplicitness returns appropriate values for evidence types", () => {
  assert.equal(calculateDefaultExplicitness("explicit_fact"), 0.9);
  assert.equal(calculateDefaultExplicitness("clear_preference"), 0.8);
  assert.equal(calculateDefaultExplicitness("direct_observation"), 0.6);
  assert.equal(calculateDefaultExplicitness("reported_by_other"), 0.4);
  assert.equal(calculateDefaultExplicitness("correction"), 0.95);
  assert.equal(calculateDefaultExplicitness("sarcasm_or_joke"), 0.2);
  assert.equal(calculateDefaultExplicitness("uncertain_inference"), 0.3);
});

test("confidence calculations are deterministic and repeatable", () => {
  const initial = calculateInitialConfidence("explicit_fact");
  const afterSupport = updateConfidence(initial, "support");
  const afterContradict = updateConfidence(afterSupport, "contradict");
  
  assert.equal(initial, 0.60);
  assert.equal(afterSupport, 0.62);
  assert.equal(afterContradict, 0.31);
  
  const repeatInitial = calculateInitialConfidence("explicit_fact");
  const repeatAfterSupport = updateConfidence(repeatInitial, "support");
  const repeatAfterContradict = updateConfidence(repeatAfterSupport, "contradict");
  
  assert.equal(initial, repeatInitial);
  assert.equal(afterSupport, repeatAfterSupport);
  assert.equal(afterContradict, repeatAfterContradict);
});