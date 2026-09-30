# Why this folder is here

A Vercel project on the altira-dev team, `npsa-scraper`, builds this folder on every push. It used to deploy the old standalone scraper front end, which the Scraper section of NPSA Tools replaced. This branch doesn't have that app, so every commit showed a failed "Vercel – npsa-scraper" check.

`vercel.json` here turns that project's deployments off for this branch and every branch made from it. The auth service never reads this folder.

The `vercel.json` at the root of this branch does the same for the `npsa-tools` project, which builds the NPSA Tools website from the repository root. This branch deploys from Railway, so Vercel had nothing to build here either. Never merge this branch into `frontend`: that root file would switch off the website's own deployments.

Once the `npsa-scraper` project is deleted in Vercel, or disconnected from this repository, this folder can be removed.
