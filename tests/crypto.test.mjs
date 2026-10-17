import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the browser ES module as an isolated data URL so the repo stays dependency-free.
const source = await readFile(new URL("../assets/js/lib.js", import.meta.url), "utf8");
const lib = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("remembered-device key is a valid 256-bit AES key and round-trips", async () => {
  const value = { config: { repo: "owner/repo", token: "github_pat_test" }, passphrase: "test sync phrase" };
  const { key, envelope } = await lib.createRememberedBundle(value);
  assert.equal(Buffer.from(key, "base64").byteLength, 32);
  assert.equal(JSON.stringify(envelope).includes(value.config.token), false);
  assert.deepEqual(await lib.decryptWithRawKey(envelope, key), value);
  const wrongKey = (await lib.createRememberedBundle({ other: true })).key;
  assert.equal(await lib.decryptWithRawKey(envelope, wrongKey), null);
});

test("sync vault conceals its token and rejects an incorrect password", async () => {
  const payload = {
    repo: "owner/repo", branch: "todolist-data", path: "data/todos.json",
    token: "github_pat_sensitive_test_value", encryptData: true, vaultId: "test-vault-id",
  };
  const password = "correct horse battery staple";
  const vault = await lib.createVault(payload, password);

  assert.equal(JSON.stringify(vault).includes(payload.token), false);
  assert.deepEqual(await lib.openVault(vault, password), payload);
  assert.equal(await lib.openVault(vault, "wrong password"), null);
});

test("encrypted envelopes reject malformed or excessive PBKDF2 work factors", async () => {
  const password = "another test password";
  const envelope = await lib.encryptJSON({ ok: true }, password);

  assert.deepEqual(await lib.decryptJSON(envelope, password), { ok: true });
  assert.equal(await lib.decryptJSON({ ...envelope, iter: 99_999 }, password), null);
  assert.equal(await lib.decryptJSON({ ...envelope, iter: 1_000_001 }, password), null);
  assert.equal(await lib.decryptJSON({ ...envelope, kdf: "unsupported" }, password), null);
});
