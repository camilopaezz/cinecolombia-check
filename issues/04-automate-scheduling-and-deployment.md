---
title: "Automate scheduling and deployment"
labels: ready-for-agent
---

## What to build

Put the scraper on a schedule and wire it to publish its generated output automatically to the GitHub Pages branch, only when something has changed.

The slice must:
- Provide a `systemd` service unit that runs the scraper with an `EnvironmentFile` pointing to `/etc/cineco.env` (chmod 600, gitignored).
- Provide a `systemd` timer that triggers the service every 6 hours (`OnCalendar=*-*-* 00/6:00`) with `Persistent=true` so missed runs catch up after downtime or reboot.
- After a successful scrape, check `git diff` to see whether `/docs` or `/data` changed.
- If nothing changed, exit successfully without committing.
- If something changed, commit the generated files with a concise message and push to `main` via an SSH deploy key.
- If the push fails because of a non-fast-forward update, log the failure and abort without mutating local state; the next run will retry with the latest state.
- Ensure the scraper is idempotent across scheduled runs: repeated runs with unchanged data produce no new commits.
- Keep the SSH deploy key on the server and the corresponding public key as a write-enabled deploy key on the GitHub repo.

## Acceptance criteria

- [ ] The `systemd` unit and timer files are present and can be manually triggered with `systemctl start`.
- [ ] A scrape that changes no generated files exits cleanly and produces no commit.
- [ ] A scrape that changes generated files produces exactly one commit and attempts a push.
- [ ] A push failure leaves `state.json` and `posts.json` intact and logs the error.
- [ ] The scraper runs successfully on the scheduled timer without manual intervention.
- [ ] Documentation describes how to install the service, set up `/etc/cineco.env`, and add the SSH deploy key.

## Blocked by

- #3 — Add TMDB poster images to posts and feed

## User stories covered

- 11, 12, 16, 17
