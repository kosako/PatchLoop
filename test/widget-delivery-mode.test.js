"use strict";

// The deliveryMode init option is one of the four modes (#164). Another value
// is a mistake: it warns and is the default (the receiver), so the settings
// show where the comment goes, as it went there before too.

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const warnedMode = (w) => w.warnings.some(([message]) => String(message).includes("deliveryMode must be one of"));
const shownMode = (w) => w.document.querySelector("[data-pl-delivery-mode]").value;
const endpointShown = (w) => !w.document.querySelector("[data-pl-endpoint-field]").hidden;

test("a deliveryMode the widget does not know warns, and the comment goes to the receiver the settings show (#164)", async () => {
  for (const value of ["downlaod", "Download", "", null, 1]) {
    const w = widgetHarness();
    w.init({ deliveryMode: value, showDeliverySettings: true });
    assert.equal(warnedMode(w), true, `warned for ${String(value)}`);
    assert.equal(shownMode(w), "receiver", `the settings for ${String(value)}`);
    assert.equal(endpointShown(w), true, `the endpoint field for ${String(value)}`);
    await w.submit("Fix");
    assert.equal(w.requests.length, 1, `sent for ${String(value)}`);
  }
});

test("the four delivery modes, and none given, are taken without a warning (#164)", () => {
  for (const value of ["receiver", "slack-webhook", "download", "none", undefined]) {
    const w = widgetHarness();
    w.init({ deliveryMode: value, showDeliverySettings: true });
    assert.equal(w.warnings.length, 0, `no warning for ${String(value)}`);
    assert.equal(shownMode(w), value ?? "receiver", `the settings for ${String(value)}`);
    assert.equal(endpointShown(w), (value ?? "receiver") === "receiver", `the endpoint field for ${String(value)}`);
  }
});
