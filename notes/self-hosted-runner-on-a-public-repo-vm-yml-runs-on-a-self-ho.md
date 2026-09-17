# *Self-hosted runner on a public repo** vm.yml runs on a self-hosted KVM runner; before registering one, require approval for all fork PR workflows and restrict the runner to the vm workflow (a fork PR can otherwise run code on it)

- 2026-09-17 15:26 — 2026-09-17 audit: no runner is registered today. Both repos now have a ruleset on main (no force-push, no deletion), secret scanning with push protection, and Dependabot alerts. Fork-PR approval is still 'first-time contributors': set it to all outside contributors before registering a runner.
