# Why this folder is here

A Vercel project on the altira-dev team, `npsa-scraper`, builds this folder on every push. It used to deploy the old standalone scraper front end, which was removed from this branch in 7a6327e; the Scraper section of NPSA Tools replaced it. With the folder gone, every commit showed a failed "Vercel – npsa-scraper" check.

`vercel.json` here turns that project's deployments off for this branch and every branch made from it. NPSA Tools builds from the repository root and never reads this folder.

Once the `npsa-scraper` project is deleted in Vercel, or disconnected from this repository, this folder can be removed.
