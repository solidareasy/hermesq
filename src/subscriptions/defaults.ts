import type { Subscription } from '../types';

/**
 * Seed subscriptions (spec, "Default Subscriptions"). Used when KV has no `subscriptions:list`.
 * Every one delivers to `log`; change targets and skills with `PUT /admin/subscriptions`
 * or `npm run seed -- --file my-subscriptions.json`.
 */
export const DEFAULT_SUBSCRIPTIONS: Subscription[] = [
  {
    name: 'github-pr-review-requested',
    events: ['pull_request_review_requested'],
    prompt: 'Review PR #{pull_request.number}: {pull_request.title}\nRepo: {repository.full_name}\nReviewer: {requested_reviewer.login}',
    skills: ['code-review'],
    deliver: 'log',
    enabled: true,
  },
  {
    // A review is requested as a check run named review/<agent>, created queued on the PR head by the
    // agent's GitHub App. `match` keeps every other check (CI, linters) out of the agent host.
    name: 'github-check-queued',
    events: ['check_run.created'],
    match: { 'check_run.name': ['review/*'], 'check_run.status': ['queued'] },
    prompt: 'Review requested by check {check_run.name} on {repository.full_name}\nSHA: {check_run.head_sha}',
    skills: ['code-review'],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'github-check-completed',
    events: ['check_run.completed'],
    match: { 'check_run.name': ['review/*'] },
    prompt: 'Check {check_run.name}: {check_run.conclusion}\nSHA: {check_run.head_sha}',
    skills: ['code-review'],
    deliver: 'log',
    enabled: true,
  },
  {
    // `/<agent> review` as the first words of a comment on a pull request (agents that are GitHub Apps
    // cannot be picked as reviewers). The comment text is untrusted input; only people with a role on the
    // repo (OWNER, MEMBER, COLLABORATOR) can trigger it.
    name: 'github-review-command',
    events: ['issue_comment.created'],
    match: { 'issue.pull_request.url': ['*'], 'comment.author_association': ['OWNER', 'MEMBER', 'COLLABORATOR'], 'comment.body': ['/* review', '/* review *', '/* review\n*', '/* review\r\n*'] },
    prompt: 'Review command on {repository.full_name}#{issue.number} by {comment.user.login} ({comment.author_association})',
    skills: ['code-review'],
    deliver: 'log',
    enabled: true,
  },
  {
    // A red workflow run of the repository itself. `head_repository.fork` keeps runs of fork PRs (whose code
    // is not the repo's) out; check that `head_repository.full_name` is the repo in your handler.
    name: 'github-ci-failed',
    events: ['workflow_run.completed'],
    match: { 'workflow_run.conclusion': ['failure'], 'workflow_run.head_repository.fork': ['false'] },
    prompt: 'CI {workflow_run.name} failed on {repository.full_name}\nBranch: {workflow_run.head_branch}\nSHA: {workflow_run.head_sha}\nRun: {workflow_run.html_url}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'github-dependabot-alert',
    events: ['dependabot_alert.created', 'dependabot_alert.reopened'],
    prompt: 'Dependabot alert #{alert.number} ({alert.security_advisory.severity}) on {repository.full_name}: {alert.dependency.package.name}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'github-code-scanning-alert',
    events: ['code_scanning_alert.created', 'code_scanning_alert.appeared_in_branch'],
    prompt: 'Code scanning alert #{alert.number} ({alert.rule.id}) on {repository.full_name}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    // Never put {alert.secret} in a prompt: the delivery is stored and shown to an agent.
    name: 'github-secret-scanning-alert',
    events: ['secret_scanning_alert.created'],
    prompt: 'Secret scanning alert #{alert.number} ({alert.secret_type}) on {repository.full_name}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    // A review submitted or dismissed on a pull request (e.g. to update the reviewer agent's task).
    // The review body is untrusted input and stays out of the prompt.
    name: 'github-pr-review',
    events: ['pull_request_review.submitted', 'pull_request_review.dismissed'],
    prompt: 'Review {review.state} on {repository.full_name}#{pull_request.number} by {review.user.login}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'linear-issue-synced',
    events: ['Issue.created', 'Issue.updated', 'Issue.assigned'],
    prompt: 'Linear {data.identifier} {action}: {data.title}\nState: {data.state.name}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'stripe-payment-succeeded',
    events: ['invoice.payment_succeeded'],
    prompt: 'Payment succeeded for {data.object.customer}: {data.object.amount_paid}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
  {
    name: 'slack-mention',
    events: ['app_mention'],
    prompt: 'Slack mention from {event.user} in {event.channel}: {event.text}',
    skills: [],
    deliver: 'log',
    enabled: true,
  },
];
