# GitHub webhook payloads (recorded)

Payloads GitHub really sent, as recorded and published by
[octokit/webhooks](https://github.com/octokit/webhooks) (MIT), `payload-examples/api.github.com/`, at commit
`aa80c24a3f55354465b8b1438d33dd5602956d0d`. Copied byte for byte:

| File | Source |
|---|---|
| `check_run.created.json` | `check_run/created.with-organization.payload.json` |
| `check_run.completed.json` | `check_run/completed.with-organization.payload.json` |
| `pull_request.review_requested.json` | `pull_request/review_requested.payload.json` |
| `issue_comment.created.json` | `issue_comment/created.with-installation.payload.json` |
| `workflow_run.completed.json` | `workflow_run/completed.with-pull-requests.payload.json` |
| `dependabot_alert.created.json` | `dependabot_alert/created.payload.json` |
| `code_scanning_alert.created.json` | `code_scanning_alert/created.payload.json` |
| `secret_scanning_alert.reopened.json` | `secret_scanning_alert/reopened.payload.json` (the only recorded secret scanning event) |
| `pull_request_review.submitted.json` | `pull_request_review/submitted.payload.json` |
| `pull_request_review.dismissed.json` | `pull_request_review/dismissed.payload.json` |

Tests that need a review check or a command override only `check_run.name`/`status`/`external_id` or
`comment.body`/`issue.pull_request`, and say so in the test. The recorded `workflow_run` succeeded: the red-CI
tests set `workflow_run.conclusion` to `failure` (and `head_repository.fork` for the fork case); the secret
scanning test sets `action` to `created`. Each says so.
