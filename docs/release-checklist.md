# Release Checklist

Use this checklist before tagging a new release.

## Pre-release checks

- [ ] `package.json` and the root version fields in `package-lock.json` match the release tag (without its `v` prefix).
- [ ] `npm test` passes (types + unit tests + validation).
- [ ] Generated output is fresh: `npm run generate && git diff --exit-code README.md docs/COMPARISON.md`.
- [ ] CI green on the target commit.
- [ ] The latest scheduled `Catalog maintenance` run is green, or its confirmed-broken links have been fixed. Re-run on demand with `npm run check:links`.
- [ ] Review the stale-entry report (`npm run check:stale`) and decide whether any old entries need re-verification before the release.
- [ ] Reviewed shelf counts look reasonable — check the `Explore by intent` section of the README.
- [ ] Thin and empty shelves are acceptable — the README `Roadmap` section lists them automatically.

Validation already blocks citation artifacts, promotional description language, missing `primary_category` on reviewed multi-category tools, undefined category/tag references, and missing `review_notes` on drafts, so those need no manual scan.

## v0.3.0 Catalog Exception

The maintainer approved publishing v0.3.0 with documented catalog debt on 2026-10-11. For this release, a failed link-maintenance check does not block publication if the release notes report the check results and explicitly defer the full catalog audit to v1.0.0. This exception does not change validation or the scheduled maintenance workflow.

`curation_status: reviewed` records an earlier curation decision. It does not guarantee current availability, factual accuracy, relevance, or quality. Likewise, passing the 180-day stale-date threshold does not prove that metadata is up to date. Do not advance `last_checked` without re-verifying the entry against its sources.

Before v1.0.0, audit the published reviewed entries as well as the draft queue: remove unsuitable or duplicate entries, correct outdated metadata and links, verify official evidence, and polish categories and descriptions. Unresolved candidates may remain drafts; clearing the draft queue is not a substitute for auditing the published list.

## Tagging

This repository releases as a **GitHub release only** — do not publish to npm.

Check out the exact default-branch commit that passed CI before tagging. Use the next release version consistently in the manifests, tag, and GitHub release.

```bash
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

Then create a GitHub release from the tag with a short changelog summary.
