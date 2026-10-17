import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Same dependency-free loading trick as crypto.test.mjs: the browser module runs in Node as-is.
const source = await readFile(new URL("../assets/js/lib.js", import.meta.url), "utf8");
const lib = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("only fine-grained tokens qualify; classic tokens reach every repository", () => {
  assert.equal(lib.tokenKind("github_pat_11ABCDEF_0123456789abcdef"), "fine-grained");
  assert.equal(lib.tokenKind("ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWX"), "classic");
  assert.equal(lib.tokenKind("gho_0123456789ABCDEFGHIJKLMNOPQRSTUVWX"), "classic");
  assert.equal(lib.tokenKind("not-a-token"), "unknown");
  assert.equal(lib.tokenKind(""), "unknown");
});

test("the repository field accepts every shape a user actually pastes", () => {
  const shapes = [
    "pouriasafari117/Online_todolist",
    "  pouriasafari117/Online_todolist  ",
    "https://github.com/pouriasafari117/Online_todolist",
    "https://github.com/pouriasafari117/Online_todolist/",
    "https://github.com/pouriasafari117/Online_todolist.git",
    "https://github.com/pouriasafari117/Online_todolist/tree/main",
    "https://pouriasafari117.github.io/Online_todolist/",
    "git@github.com:pouriasafari117/Online_todolist.git",
  ];
  for (const shape of shapes) assert.equal(lib.parseRepoInput(shape), "pouriasafari117/Online_todolist", shape);
  // things that are not a repository stay invalid instead of silently syncing elsewhere
  for (const bad of ["", "only-owner", "https://github.com/only-owner", "a/b/c/d", "owner/rep o"]) {
    assert.equal(lib.parseRepoInput(bad), null, bad);
  }
});

test("a GitHub Pages site resolves its own repository", () => {
  assert.equal(
    lib.repoFromLocation({ hostname: "pouriasafari117.github.io", pathname: "/Online_todolist/" }),
    "pouriasafari117/Online_todolist"
  );
  assert.equal(
    lib.repoFromLocation({ hostname: "my-team.github.io", pathname: "/Online_todolist/index.html" }),
    "my-team/Online_todolist"
  );
  assert.equal(lib.repoFromLocation({ hostname: "pouriasafari117.github.io", pathname: "/" }), null);
  assert.equal(lib.repoFromLocation({ hostname: "localhost", pathname: "/Online_todolist/" }), null);
  assert.equal(lib.repoFromLocation(undefined), null);
});

test("the token link pre-fills name, resource owner, expiration and contents:write", () => {
  const url = new URL(lib.tokenCreateUrl({ owner: "pouriasafari117", repo: "Online_todolist" }));
  assert.equal(url.origin + url.pathname, "https://github.com/settings/personal-access-tokens/new");
  assert.equal(url.searchParams.get("target_name"), "pouriasafari117");
  assert.equal(url.searchParams.get("contents"), "write");
  assert.equal(url.searchParams.get("expires_in"), "366");
  assert.ok(url.searchParams.get("name").length <= 40);
  assert.match(url.searchParams.get("description"), /Online_todolist/);
  // a name longer than GitHub's 40-character limit is truncated, not rejected
  assert.equal(
    new URL(lib.tokenCreateUrl({ owner: "o", repo: "x".repeat(80) })).searchParams.get("name").length,
    40
  );
  assert.equal(lib.tokenCreateUrl({ owner: "", repo: "" }), "https://github.com/settings/personal-access-tokens/new");
});

test("GitHub client reads classic scopes and the repositories a credential reaches", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    if (url.endsWith("/user")) return json("", 200, { "x-oauth-scopes": "repo, workflow" });
    if (url.includes("/user/repos")) return json([{ full_name: "me/other" }, { full_name: "me/todolist" }]);
    return json({ message: "Not Found" }, 404);
  };
  const gh = new lib.GitHub("github_pat_test");
  assert.deepEqual(await gh.oauthScopes(), ["repo", "workflow"]);
  assert.deepEqual(await gh.accessibleRepos(), ["me/other", "me/todolist"]);
  assert.ok(seen.some((u) => u.includes("per_page=100")));

  // when the endpoint is not granted to the token we must degrade, never break the flow
  globalThis.fetch = async () => json({ message: "Forbidden" }, 403);
  assert.equal(await new lib.GitHub("github_pat_test").accessibleRepos(), null);
});

test("scope audit refuses broad tokens and tokens that cannot see this repository", async () => {
  const fake = ({ scopes = [], repos = null, repoVisible = true } = {}) => ({
    oauthScopes: async () => scopes,
    accessibleRepos: async () => repos,
    repoInfo: async () => {
      if (!repoVisible) throw new lib.GhError(404, "not-found");
      return { default_branch: "main" };
    },
  });
  const token = "github_pat_11ABCDEF_0123456789abcdef";

  // the exact token the list needs: one repo, contents access, nothing else
  assert.deepEqual(await lib.auditTokenScope(fake({ repos: ["me/Online_todolist"] }), token, "me/Online_todolist"), {
    ok: true, others: [], info: { default_branch: "main" },
  });
  // case-insensitive match so a differently-cased repo name is not flagged
  assert.equal((await lib.auditTokenScope(fake({ repos: ["Me/online_todolist"] }), token, "me/Online_todolist")).ok, true);

  assert.equal((await lib.auditTokenScope(fake(), "ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWX", "me/Online_todolist")).reason, "classic");
  assert.equal((await lib.auditTokenScope(fake(), "nonsense", "me/Online_todolist")).reason, "unknown");
  // a classic OAuth scope header means all-repository access even without a ghp_ prefix
  assert.equal((await lib.auditTokenScope(fake({ scopes: ["repo"] }), token, "me/Online_todolist")).reason, "classic");

  const broad = await lib.auditTokenScope(fake({ repos: ["me/Online_todolist", "me/other", "me/third"] }), token, "me/Online_todolist");
  assert.equal(broad.reason, "broad");
  assert.deepEqual(broad.others, ["me/other", "me/third"]);

  const noRepo = await lib.auditTokenScope(fake({ repos: [], repoVisible: false }), token, "me/Online_todolist");
  assert.equal(noRepo.reason, "no-repo");
  // an endpoint the token cannot use must not turn into a false accusation
  assert.equal((await lib.auditTokenScope(fake({ repos: null, repoVisible: false }), token, "me/Online_todolist")).reason, "no-repo");
});

test("scope audit still refuses a token when the repository listing is unavailable", async () => {
  const fake = {
    oauthScopes: async () => [],
    accessibleRepos: async () => { throw new lib.GhError(0, "network"); },
    repoInfo: async () => ({ default_branch: "main" }),
  };
  assert.equal((await lib.auditTokenScope(fake, "github_pat_11ABCDEF_0123456789abcdef", "me/Online_todolist")).ok, true);
});
