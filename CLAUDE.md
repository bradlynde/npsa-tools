# Project notes for Claude Code

## Pull requests: wait for approval before merging

Do not merge a pull request into `loe-generator` without explicit approval
from Stuart on that specific PR.

Take the work all the way up to the merge — commit, push, open the PR, wait
for the `build` check to pass — then share the PR link and a summary of what
changed, and stop there. Approval on one PR does not carry over to the next.

After approval, re-check the base before merging: `loe-generator` moves often
(the Salesforce/marketing workstream lands there regularly), so re-fetch,
rebase onto the current tip, and re-run the build. If the rebase produces a
real conflict, bring it back rather than resolving it silently.

## How the merge itself happens

`loe-generator` is covered by the "loe-generator protection" ruleset, which
requires a pull request, requires the `build` status check, and blocks
force-pushes and deletion. So the change has to go through a PR with a green
build. That part is stable.

**Use the GitHub API merge endpoint** — `mcp__github__merge_pull_request`, or
`PUT /repos/.../pulls/<n>/merge`. It is the only route available to a session.

**Do not fall back to a fast-forward push.** An earlier version of this file
offered `git push origin HEAD:loe-generator` as a second route. It is not one.
The permission classifier refuses that push before it ever reaches the
ruleset, and the refusal is a deliberate guard on branch protection — routing
around it defeats the thing that makes the PR requirement mean anything. If
the API merge cannot complete, say so and stop.

### A draft PR cannot be merged

Open PRs as drafts, as usual. But a draft has no merge button: GitHub swaps it
for "Ready for review", and the API refuses the merge as well. Clear the draft
flag first — `update_pull_request` with `draft: false` — and then merge.

This one fails silently. Clicking the disabled merge button in the browser
does nothing and reports nothing, so a PR can look merged to whoever clicked
it while GitHub never registered a thing.

### The rate limit throttles writes, not reads

Merges fail fairly often with:

    API rate limit already exceeded for user ID <id>

This is GitHub's *secondary* rate limit, which targets bursts of
state-changing requests — not the 5,000/hour primary quota, which this
workload comes nowhere near. The tell is that reads keep working while writes
fail: `pull_request_read` succeeds in the same minute that
`update_pull_request` and `merge_pull_request` are both refused.

So when it hits, state can still be verified; it just cannot be changed. Say
that plainly and let Stuart merge in the browser — his own session has a
separate quota and is unaffected. It cools off by itself. A long poll is fine;
rapid retries are not, since each retry is another write.

Keep write calls to a minimum for the same reason. Re-reading a PR's state
immediately after creating it spends budget on something already known.

### Verify that the merge actually happened

Never report a merge on the strength of having asked for one. Fetch and look:

    git fetch origin <branch>
    git log --oneline origin/<branch> -2

If a merge is believed done but the branch has not moved, check the PR's
`updated_at`. That field moves on *any* change, including clearing the draft
flag — so a value still equal to `created_at` means nothing reached GitHub at
all, and the problem is upstream of the merge rather than in it.

## The same flow applies to `frontend`

The Next.js toolbox lives on `frontend` and now carries the marketing
dashboard; the older Vite copy was retired in #103/#104, so there is one
rendering of those figures rather than two. Merges there follow the same
route: draft PR, green checks, clear the draft, API merge, verify by fetching.
That branch's history uses merge commits, so merge with `merge` rather than
squash or rebase.

The Express backend stays on `loe-generator` and remains the single source for
every marketing figure. `frontend` reads it through the proxy at
`app/api/marketing/[...path]/route.ts`.

## Do not "fix" signatures on commits that are already merged

A branch pointed at the `loe-generator` tip with no commits of its own will
show that branch's history as unpushed, and a merge commit GitHub created
carries a committer of `noreply@github.com`. Neither is a problem to repair.
The fix is to move the branch pointer — `git reset --hard origin/<branch>` —
never to rewrite someone else's commit with `--reset-author`.
