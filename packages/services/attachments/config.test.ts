/**
 * Tests for the attachment cache configuration, and specifically for the
 * environment prefix.
 *
 * WHY THE PREFIX GETS ITS OWN TEST FILE. It is the isolation boundary between
 * deployments sharing one Spaces bucket, and every one of its failure modes is
 * silent: a missing prefix writes un-prefixed keys that another environment can
 * collide with, and a *normalised* prefix sends this deployment's objects
 * somewhere the operator did not choose. Neither surfaces as an error at the
 * time — they surface later as objects that overwrite each other, or as an
 * eviction sweep deleting another environment's files.
 *
 * So these cases assert the two things that keep that shut: it is REQUIRED, and
 * it is REJECTED rather than repaired.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAttachmentCacheConfig,
  __resetAttachmentCacheConfig,
} from "./config.ts";

const VARS = [
  "ATTACHMENT_CACHE_ENABLED",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_PREFIX",
] as const;

/** Run `fn` against exactly `env`, restoring the real process env afterwards. */
function withEnv(env: Partial<Record<(typeof VARS)[number], string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, env);
  __resetAttachmentCacheConfig();
  try {
    fn();
  } finally {
    for (const key of VARS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetAttachmentCacheConfig();
  }
}

const COMPLETE = {
  ATTACHMENT_CACHE_ENABLED: "true",
  OBJECT_STORAGE_ENDPOINT: "https://sgp1.digitaloceanspaces.com",
  OBJECT_STORAGE_REGION: "sgp1",
  OBJECT_STORAGE_BUCKET: "mailroid-attachment-cache",
  OBJECT_STORAGE_ACCESS_KEY_ID: "key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
  OBJECT_STORAGE_PREFIX: "dev",
} as const;

test("a complete configuration resolves, prefix included", () => {
  withEnv(COMPLETE, () => {
    const config = resolveAttachmentCacheConfig();
    assert.ok(config);
    assert.equal(config.prefix, "dev");
    assert.equal(config.bucket, "mailroid-attachment-cache");
  });
});

test("the cache stays off without the flag, and reads no other variable", () => {
  withEnv({ OBJECT_STORAGE_PREFIX: "dev" }, () => {
    assert.equal(resolveAttachmentCacheConfig(), null);
  });
});

test("THE PREFIX IS REQUIRED: the flag on without one refuses to boot", () => {
  // The case that matters most operationally. Without this, a deployment could
  // run the cache with no isolation prefix and write keys a second deployment
  // would collide with — discovered only once objects started overwriting.
  const { OBJECT_STORAGE_PREFIX: _omitted, ...withoutPrefix } = COMPLETE;
  withEnv(withoutPrefix, () => {
    assert.throws(
      () => resolveAttachmentCacheConfig(),
      /OBJECT_STORAGE_PREFIX/,
      "the error must name the missing variable",
    );
  });
});

// ── Rejected, never normalised ────────────────────────────────────────
//
// Each of these could plausibly be "helpfully" repaired into "dev". None is.
// A prefix decides WHERE THIS DEPLOYMENT'S DATA LIVES, so a typo has to stop
// the process rather than quietly relocate its objects.

for (const [label, value] of [
  ["uppercase", "Dev"],
  ["a trailing slash", "dev/"],
  ["an embedded slash", "a/b"],
  ["path traversal", "../x"],
  ["trailing whitespace", "dev "],
  ["leading whitespace", " dev"],
  ["whitespace only", "   "],
  ["a leading hyphen", "-dev"],
  ["a dot", "dev.1"],
] as const) {
  test(`the prefix is rejected, not normalised: ${label} (${JSON.stringify(value)})`, () => {
    withEnv({ ...COMPLETE, OBJECT_STORAGE_PREFIX: value }, () => {
      assert.throws(
        () => resolveAttachmentCacheConfig(),
        /OBJECT_STORAGE_PREFIX/,
        `${JSON.stringify(value)} must throw rather than be corrected`,
      );
    });
  });
}

test("a rejected prefix never resolves to a repaired value", () => {
  // Asserted separately from the throws above, because the failure this guards
  // is someone later adding a normalisation step: the config would then resolve
  // successfully and every `assert.throws` above would fail loudly — but a test
  // that only checked the resulting key would pass, silently accepting "Dev".
  withEnv({ ...COMPLETE, OBJECT_STORAGE_PREFIX: "Dev" }, () => {
    let resolved: unknown;
    try {
      resolved = resolveAttachmentCacheConfig();
    } catch {
      return; // correct: it threw
    }
    assert.fail(`"Dev" resolved to ${JSON.stringify(resolved)} instead of throwing`);
  });
});

test("legitimate prefixes are accepted", () => {
  for (const value of ["dev", "prod", "staging-2", "pr-1234", "a", "0"]) {
    withEnv({ ...COMPLETE, OBJECT_STORAGE_PREFIX: value }, () => {
      assert.equal(resolveAttachmentCacheConfig()?.prefix, value);
    });
  }
});
