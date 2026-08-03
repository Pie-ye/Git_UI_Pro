import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HostingService, parseHostingRemote } = require("../dist-electron/hostingService.js");
const remoteUrls = {
  github: "https://github.com/example/project.git",
  gitlab: "https://gitlab.com/example/project.git",
  gitee: "https://gitee.com/example/project.git"
};
const headSha = "a".repeat(40);

function createService(requestJson) {
  const service = new HostingService(path.join(os.tmpdir(), `git-ui-pro-hosting-${Math.random().toString(16).slice(2)}`));
  service.requireToken = async () => "token";
  service.requestJson = requestJson;
  return service;
}

function githubChange(overrides = {}) {
  return {
    id: 1,
    number: 1,
    title: "Change",
    state: "open",
    draft: false,
    user: { login: "author" },
    head: { ref: "feature", sha: headSha },
    base: { ref: "main" },
    html_url: "https://github.com/example/project/pull/1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    mergeable: true,
    mergeable_state: "clean",
    ...overrides
  };
}

function gitlabChange(overrides = {}) {
  return {
    id: 4,
    iid: 4,
    title: "Change",
    state: "opened",
    draft: false,
    author: { username: "author" },
    source_branch: "feature",
    target_branch: "main",
    sha: headSha,
    web_url: "https://gitlab.com/example/project/-/merge_requests/4",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    detailed_merge_status: "mergeable",
    ...overrides
  };
}

test("change request lists load every page instead of truncating at the first page", async () => {
  const calls = [];
  const service = createService(async (_target, _token, method, apiPath) => {
    calls.push({ method, apiPath });
    const page = Number(new URL(`https://api.test${apiPath}`).searchParams.get("page"));
    return page === 1
      ? Array.from({ length: 100 }, (_, index) => githubChange({ id: index + 1, number: index + 1 }))
      : [githubChange({ id: 101, number: 101 })];
  });

  const changes = await service.listChangeRequests("github", remoteUrls.github);
  assert.equal(changes.length, 101);
  assert.equal(calls.length, 2);
  assert.match(calls[0].apiPath, /per_page=100&page=1/);
  assert.match(calls[1].apiPath, /per_page=100&page=2/);
});

test("Gitee draft creation sends the official draft field", async () => {
  let request;
  const service = createService(async (_target, _token, method, apiPath, body) => {
    request = { method, apiPath, body };
    return {
      ...githubChange(),
      html_url: "https://gitee.com/example/project/pulls/1",
      draft: true
    };
  });

  const change = await service.createChangeRequest("gitee", remoteUrls.gitee, {
    title: "Draft change",
    sourceBranch: "feature",
    targetBranch: "main",
    draft: true
  });
  assert.equal(request.method, "POST");
  assert.equal(request.body.draft, true);
  assert.equal(change.draft, true);
});

test("remote parsing rejects public-provider mismatches and ignores explicit SSH ports for HTTPS APIs", () => {
  const target = parseHostingRemote("github", "ssh://git@github.com:22/example/project.git");
  assert.equal(target.host, "github.com");
  assert.equal(target.origin, "https://github.com");
  assert.equal(target.ownerPath, "example");
  assert.throws(
    () => parseHostingRemote("gitlab", "https://github.com/example/project.git"),
    /属于 GitHub，不能使用 GitLab 账号访问/
  );
});

test("cross-fork creation keeps the fetch repository as target and the push repository as source", async () => {
  const githubCalls = [];
  const github = createService(async (_target, _token, method, apiPath, body) => {
    githubCalls.push({ method, apiPath, body });
    return githubChange();
  });
  await github.createChangeRequest("github", remoteUrls.github, {
    title: "Fork change",
    sourceBranch: "feature",
    targetBranch: "main",
    sourceRemoteUrl: "https://github.com/contributor/project.git"
  });
  assert.equal(githubCalls[0].apiPath, "/repos/example/project/pulls");
  assert.equal(githubCalls[0].body.head, "contributor:feature");

  const gitlabCalls = [];
  const gitlab = createService(async (_target, _token, method, apiPath, body) => {
    gitlabCalls.push({ method, apiPath, body });
    if (method === "GET") return { id: 42 };
    return gitlabChange();
  });
  await gitlab.createChangeRequest("gitlab", remoteUrls.gitlab, {
    title: "Fork change",
    sourceBranch: "feature",
    targetBranch: "main",
    sourceRemoteUrl: "https://gitlab.com/contributor/project.git"
  });
  assert.equal(gitlabCalls[0].apiPath, "/projects/contributor%2Fproject");
  assert.equal(gitlabCalls[1].apiPath, "/projects/example%2Fproject/merge_requests");
  assert.equal(gitlabCalls[1].body.source_project_id, 42);
});

test("ordinary comments use comment endpoints and never formal review endpoints", async () => {
  const calls = [];
  const service = createService(async (_target, _token, method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    return {};
  });

  await service.addComment("github", remoteUrls.github, 7, "Please clarify");
  assert.deepEqual(calls, [{
    method: "POST",
    apiPath: "/repos/example/project/issues/7/comments",
    body: { body: "Please clarify" }
  }]);
});

test("reviews carry the reviewed head SHA and GitLab requests changes atomically", async () => {
  const githubCalls = [];
  const github = createService(async (_target, _token, method, apiPath, body) => {
    githubCalls.push({ method, apiPath, body });
    return {};
  });
  await github.reviewChangeRequest("github", remoteUrls.github, { number: 3, headSha, event: "approve" });
  assert.equal(githubCalls[0].body.commit_id, headSha);

  const gitlabCalls = [];
  const gitlab = createService(async (_target, _token, method, apiPath, body) => {
    gitlabCalls.push({ method, apiPath, body });
    return method === "GET" ? gitlabChange() : {};
  });
  await gitlab.reviewChangeRequest("gitlab", remoteUrls.gitlab, {
    number: 4,
    headSha,
    event: "request-changes",
    body: "Tests are missing"
  });
  assert.deepEqual(gitlabCalls, [
    {
      method: "GET",
      apiPath: "/projects/example%2Fproject/merge_requests/4",
      body: undefined
    },
    {
      method: "POST",
      apiPath: "/projects/example%2Fproject/merge_requests/4/draft_notes/bulk_publish",
      body: { note: "Tests are missing", reviewer_state: "requested_changes" }
    }
  ]);

  const approveCalls = [];
  const gitlabApprove = createService(async (_target, _token, method, apiPath, body) => {
    approveCalls.push({ method, apiPath, body });
    return {};
  });
  await gitlabApprove.reviewChangeRequest("gitlab", remoteUrls.gitlab, { number: 4, headSha, event: "approve" });
  assert.deepEqual(approveCalls, [{
    method: "POST",
    apiPath: "/projects/example%2Fproject/merge_requests/4/approve",
    body: { sha: headSha }
  }]);

  await assert.rejects(
    () => gitlab.reviewChangeRequest("gitee", remoteUrls.gitee, { number: 4, headSha, event: "request-changes", body: "Change it" }),
    /Gitee 不支持“请求修改”审核操作/
  );
  assert.equal(gitlabCalls.length, 2);
});

test("merge preflight rejects unknown or stale heads and sends exact SHA on supported APIs", async () => {
  const unknown = createService(async (_target, _token, method) => {
    assert.equal(method, "GET");
    return githubChange({ mergeable: null, mergeable_state: "unknown" });
  });
  await assert.rejects(
    () => unknown.mergeChangeRequest("github", remoteUrls.github, { number: 1, headSha, method: "squash" }),
    /尚未确认/
  );

  const stale = createService(async () => githubChange({ head: { ref: "feature", sha: "b".repeat(40) } }));
  await assert.rejects(
    () => stale.mergeChangeRequest("github", remoteUrls.github, { number: 1, headSha, method: "merge" }),
    /已有新提交/
  );

  const calls = [];
  const ready = createService(async (_target, _token, method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    return method === "GET" ? githubChange() : { merged: true };
  });
  await ready.mergeChangeRequest("github", remoteUrls.github, { number: 1, headSha, method: "rebase" });
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(calls[1].body, { merge_method: "rebase", sha: headSha });

  const gitlabCalls = [];
  const gitlab = createService(async (_target, _token, method, apiPath, body) => {
    gitlabCalls.push({ method, apiPath, body });
    return method === "GET" ? gitlabChange() : { state: "merged" };
  });
  await gitlab.mergeChangeRequest("gitlab", remoteUrls.gitlab, { number: 4, headSha, method: "squash" });
  assert.deepEqual(gitlabCalls[1].body, {
    squash: true,
    should_remove_source_branch: false,
    sha: headSha
  });
});
