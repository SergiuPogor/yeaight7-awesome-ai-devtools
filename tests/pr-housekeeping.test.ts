import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

type Pull = {
  state: string;
  draft: boolean;
  user: { login: string; type: string };
  assignees: { login: string }[];
  requested_reviewers: { login: string }[];
};

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  state: "open", draft: false, user: { login: "contributor", type: "User" },
  assignees: [{ login: "maintainer" }], requested_reviewers: [], ...overrides
});

async function runWorkflow(name: string, pr: Pull, options: {
  assignable?: boolean;
  reviews?: { user: { login: string }; state: string }[];
  apiError?: Error;
  number?: string;
} = {}) {
  const path = new URL(`../.github/workflows/${name}.yml`, import.meta.url);
  assert.ok(existsSync(path), `${name} workflow must exist`);
  const workflow = YAML.parse(readFileSync(path, "utf8"));
  const jobs = Object.values(workflow.jobs) as { steps: { with?: { script?: string } }[] }[];
  const script = jobs.flatMap(job => job.steps).find(step => step.with?.script)?.with?.script;
  assert.ok(script, "workflow must have executable github-script code");
  const writes: unknown[] = [];
  const warnings: string[] = [];
  const github = {
    rest: {
      pulls: {
        get: async (args: unknown) => {
          assert.deepEqual(args, { owner: "owner", repo: "repo", pull_number: 52 });
          if (options.apiError) throw options.apiError;
          return { data: pr };
        },
        listReviews: "reviews",
        requestReviewers: async (args: unknown) => { writes.push(args); }
      },
      issues: {
        checkUserCanBeAssigned: async (args: unknown) => {
          assert.deepEqual(args, { owner: "owner", repo: "repo", assignee: "contributor" });
          if (options.assignable === false) throw Object.assign(new Error("Not assignable"), { status: 404 });
        },
        addAssignees: async (args: unknown) => { writes.push(args); return { data: { assignees: [...pr.assignees, pr.user] } }; }
      }
    },
    paginate: async (method: string, args: unknown) => {
      assert.equal(method, "reviews");
      assert.deepEqual(args, { owner: "owner", repo: "repo", pull_number: 52, per_page: 100 });
      return options.reviews ?? [];
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Execute the actual workflow script; only external GitHub APIs are faked.
  await new AsyncFunction("github", "context", "core", "process", script)(
    github, { repo: { owner: "owner", repo: "repo" } },
    { info: () => {}, warning: (message: string) => warnings.push(message) },
    { env: { PR_NUMBER: options.number ?? "52" } }
  );
  return { writes, warnings };
}

test("author assignment adds the author while preserving manual assignees, including drafts", async () => {
  const { writes } = await runWorkflow("assign-author", pull({ draft: true }));
  assert.deepEqual(writes, [{ owner: "owner", repo: "repo", issue_number: 52, assignees: ["contributor"] }]);
});

for (const [name, pr] of [
  ["bots", pull({ user: { login: "dependabot[bot]", type: "Bot" } })],
  ["closed PRs", pull({ state: "closed" })],
  ["already assigned authors", pull({ assignees: [{ login: "contributor" }] })]
] as const) {
  test(`author assignment skips ${name}`, async () => {
    assert.deepEqual((await runWorkflow("assign-author", pr)).writes, []);
  });
}

test("author assignment skips an ineligible author with a visible warning", async () => {
  const result = await runWorkflow("assign-author", pull(), { assignable: false });
  assert.deepEqual(result.writes, []);
  assert.equal(result.warnings.length, 1);
});

test("review requests add yeaight7 without replacing other reviewers", async () => {
  const result = await runWorkflow("request-review", pull({ requested_reviewers: [{ login: "another-reviewer" }] }));
  assert.deepEqual(result.writes, [{ owner: "owner", repo: "repo", pull_number: 52, reviewers: ["yeaight7"] }]);
});

for (const [name, pr] of [
  ["drafts", pull({ draft: true })],
  ["closed PRs", pull({ state: "closed" })],
  ["self review", pull({ user: { login: "yeaight7", type: "User" } })],
  ["pending requests", pull({ requested_reviewers: [{ login: "yeaight7" }] })]
] as const) {
  test(`review requests skip ${name}`, async () => {
    assert.deepEqual((await runWorkflow("request-review", pr)).writes, []);
  });
}

for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) {
  test(`review requests do not re-request after a completed ${state} review`, async () => {
    const result = await runWorkflow("request-review", pull(), { reviews: [{ user: { login: "yeaight7" }, state }] });
    assert.deepEqual(result.writes, []);
  });
}

test("a ready PR can request review after a dismissed review", async () => {
  const result = await runWorkflow("request-review", pull(), { reviews: [{ user: { login: "yeaight7" }, state: "DISMISSED" }] });
  assert.equal(result.writes.length, 1);
});

for (const name of ["assign-author", "request-review"]) {
  test(`${name} surfaces unexpected API failures`, async () => {
    await assert.rejects(runWorkflow(name, pull(), { apiError: new Error("API unavailable") }), /API unavailable/);
  });
  test(`${name} rejects invalid manual PR numbers before calling GitHub`, async () => {
    await assert.rejects(runWorkflow(name, pull(), { number: "52;echo bad" }), /PR number/);
  });
}
