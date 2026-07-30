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

Note that merges here happen by fast-forward push (`git push origin
HEAD:loe-generator`), because the GitHub API merge endpoint is blocked in this
environment.
