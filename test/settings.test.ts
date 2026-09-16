/**
 * Tests for the settings.json reader.
 *
 * The rule is short and mostly about absence: project beats global, anything
 * unset or unreadable means "on", and a non-boolean never silently turns folding
 * off. These cover each of those and the nesting, since the key is the only
 * contract users have.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dmailEnabledIn, resolveDmailEnabled } from "../settings.ts";

test("reads the nested boolean", () => {
	assert.equal(dmailEnabledIn('{"dmail":{"enabled":false}}'), false);
	assert.equal(dmailEnabledIn('{"dmail":{"enabled":true}}'), true);
});

test("other settings and nesting are ignored", () => {
	assert.equal(dmailEnabledIn('{"theme":"dark","compaction":{"enabled":false}}'), undefined);
	assert.equal(dmailEnabledIn('{"dmail":{"fold":false}}'), undefined);
	assert.equal(dmailEnabledIn("{}"), undefined);
});

test("a missing file or malformed JSON says nothing", () => {
	assert.equal(dmailEnabledIn(undefined), undefined);
	assert.equal(dmailEnabledIn("{"), undefined);
	assert.equal(dmailEnabledIn(""), undefined);
});

test("a non-boolean enabled is not trusted", () => {
	assert.equal(dmailEnabledIn('{"dmail":{"enabled":"false"}}'), undefined);
	assert.equal(dmailEnabledIn('{"dmail":{"enabled":null}}'), undefined);
	assert.equal(dmailEnabledIn('{"dmail":null}'), undefined);
	assert.equal(dmailEnabledIn('{"dmail":[]}'), undefined);
});

test("unconfigured means on", () => {
	assert.equal(resolveDmailEnabled(undefined, undefined), true);
	assert.equal(resolveDmailEnabled("{}", "{}"), true);
	assert.equal(resolveDmailEnabled('{"dmail":{"enabled":true}}', undefined), true);
});

test("project overrides global in both directions", () => {
	assert.equal(resolveDmailEnabled('{"dmail":{"enabled":true}}', '{"dmail":{"enabled":false}}'), false);
	assert.equal(resolveDmailEnabled('{"dmail":{"enabled":false}}', '{"dmail":{"enabled":true}}'), true);
});

test("a silent project file falls through to global", () => {
	assert.equal(resolveDmailEnabled('{"dmail":{"enabled":false}}', "{}"), false);
	assert.equal(resolveDmailEnabled('{"dmail":{"enabled":false}}', "{"), false);
});
