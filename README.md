# ScoutAI GitHub Action

Autonomous QA testing powered by AI. ScoutAI analyzes your code changes and automatically generates and runs end-to-end tests.

## Quick Start

```yaml
name: ScoutAI QA

on:
  pull_request:
  deployment_status:  # Triggers on preview deployments

permissions:
  contents: read
  pull-requests: write
  issues: write        # Required for create-issues feature
  deployments: read    # Required for preview URL detection

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: anicol/scoutai-action@v1
        with:
          api-key: ${{ secrets.SCOUTAI_API_KEY }}
          base-url: https://your-app.com
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Features

- **AI-Powered Test Generation** - Analyzes your diff and generates targeted tests
- **Preview URL Detection** - Auto-detects Vercel/Netlify preview deployments
- **GitHub Issue Creation** - Automatically creates issues for test failures
- **PR Comments** - Posts detailed test results on your pull requests
- **Authentication Support** - Test protected pages with configurable credentials

## Usage Examples

### Basic PR Testing

```yaml
- uses: anicol/scoutai-action@v1
  with:
    api-key: ${{ secrets.SCOUTAI_API_KEY }}
    base-url: http://localhost:3000
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### With Preview URL Auto-Detection (Vercel/Netlify)

The action automatically detects preview URLs from:
- Vercel bot comments on PRs
- Netlify bot comments on PRs
- GitHub deployment status events

```yaml
name: ScoutAI QA

on:
  pull_request:
  deployment_status:  # Triggers when preview deploys complete

jobs:
  qa:
    runs-on: ubuntu-latest
    # Only run on successful deployments or PRs
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success')
    steps:
      - uses: anicol/scoutai-action@v1
        with:
          api-key: ${{ secrets.SCOUTAI_API_KEY }}
          # base-url is optional - will auto-detect from deployment
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### With Authentication

```yaml
- uses: anicol/scoutai-action@v1
  with:
    api-key: ${{ secrets.SCOUTAI_API_KEY }}
    base-url: https://staging.example.com
    auth-username: ${{ secrets.TEST_USER_EMAIL }}
    auth-password: ${{ secrets.TEST_USER_PASSWORD }}
    auth-login-url: /login
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### With Issue Creation for Failures

```yaml
- uses: anicol/scoutai-action@v1
  with:
    api-key: ${{ secrets.SCOUTAI_API_KEY }}
    base-url: https://staging.example.com
    create-issues: true  # Creates GitHub Issues for test failures
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Nightly Deep Exploration

```yaml
name: Nightly QA

on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC
  workflow_dispatch:

jobs:
  deep-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: anicol/scoutai-action@v1
        with:
          api-key: ${{ secrets.SCOUTAI_API_KEY }}
          base-url: https://staging.example.com
          mode: deep
          create-issues: true
          environment: staging
          trigger: schedule
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | - | Your ScoutAI API key |
| `base-url` | No | - | URL to test. Auto-detected from preview deployments if not provided |
| `mode` | No | `fast` | Test mode: `fast` (60s) or `deep` (9min) |
| `project-id` | No | - | ScoutAI project ID (auto-detected from repo if not provided) |
| `api-endpoint` | No | `https://scoutai-api.onrender.com` | ScoutAI API endpoint |
| `auth-username` | No | - | Username/email for test account authentication |
| `auth-password` | No | - | Password for test account authentication |
| `auth-login-url` | No | `/login` | Login page URL path |
| `environment` | No | `staging` | Environment: `staging`, `production`, or `preview` |
| `trigger` | No | auto | What triggered the run: `pr`, `schedule`, `manual`, `deployment` |
| `create-issues` | No | `false` | Create GitHub Issues for test failures |

## Outputs

| Output | Description |
|--------|-------------|
| `run-id` | The ScoutAI run ID |
| `status` | Overall status: `passed`, `failed`, or `error` |
| `summary` | JSON summary with pass/fail counts |

## Required Permissions

The action requires a `GITHUB_TOKEN` with appropriate permissions:

```yaml
permissions:
  contents: read        # Read repository content
  pull-requests: write  # Post PR comments
  issues: write         # Create issues (if create-issues: true)
  deployments: read     # Detect preview URLs from deployments
```

The `GITHUB_TOKEN` is automatically provided by GitHub Actions - you just need to pass it via the `env` block.

## How It Works

1. **Analyzes your PR** - Examines the code diff to understand what changed
2. **Detects environment** - Auto-detects preview URLs from Vercel/Netlify deployments
3. **Crawls your app** - Discovers page structure, forms, buttons, and links
4. **Generates tests** - AI creates targeted Playwright tests based on changes
5. **Runs tests** - Executes tests against your application (60s fast / 9min deep)
6. **Reports results** - Posts summary on PR, optionally creates issues for failures

## Webhook Integration

For automatic testing on every deployment, configure webhooks in your deployment platform:

| Platform | Webhook URL |
|----------|-------------|
| Vercel | `https://scoutai-api.onrender.com/api/webhooks/vercel/` |
| Netlify | `https://scoutai-api.onrender.com/api/webhooks/netlify/` |
| Render | `https://scoutai-api.onrender.com/api/webhooks/render/` |

## Getting Started

1. Sign up at [scoutai.dev](https://scoutai.dev) to get your API key
2. Add `SCOUTAI_API_KEY` to your repository secrets (Settings > Secrets > Actions)
3. Create `.github/workflows/scoutai.yml` with the workflow configuration
4. Open a PR to see ScoutAI in action!

## License

MIT
