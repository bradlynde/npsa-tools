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
build either way — that part is stable.

What is *not* stable is the route used to perform the merge. Two exist:

- the GitHub API merge endpoint (`PUT /repos/.../pulls/<n>/merge`), and
- a fast-forward push (`git push origin HEAD:loe-generator`).

Both have been observed blocked at different times, and they fail for
unrelated reasons — the API merge can be refused by the session's own egress
policy ("not permitted for this session type"), while a direct push can be
refused by the ruleset. API calls and git traffic also travel through
different proxies here, so one working says nothing about the other.

Try the API merge first; if it is refused, fall back to the fast-forward
push. Verify which one works at the time rather than assuming, and report a
merge that could not be completed instead of forcing it through.

Do not "fix" unverified-signature warnings on commits that are already
merged. A branch sitting at the `loe-generator` tip with no commits of its
own will show that branch's history as unpushed; the fix is to move the
branch pointer forward, never to rewrite other people's commits with
`--reset-author`.
