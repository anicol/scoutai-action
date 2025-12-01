# ScoutAI GitHub Action

Autonomous QA testing powered by AI. ScoutAI analyzes your code changes and automatically generates and runs end-to-end tests.

## Usage

```yaml
name: ScoutAI QA

on:
  pull_request:
  schedule:
    - cron: '0 2 * * *'  # Nightly at 2am UTC

permissions:
  contents: read
  pull-requests: write

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Your build steps here...
      - name: Build and start app
        run: |
          npm ci
          npm run build
          npx serve -s dist -l 3000 &
          sleep 5

      - uses: anicol/scoutai-action@v1
        with:
          api-key: ${{ secrets.SCOUTAI_API_KEY }}
          base-url: http://localhost:3000
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | - | Your ScoutAI API key |
| `base-url` | Yes | - | URL where your app is running |
| `mode` | No | `fast` | Test mode: `fast` (60s) or `deep` (10min) |
| `project-id` | No | - | ScoutAI project ID (auto-detected from repo) |

## Outputs

| Output | Description |
|--------|-------------|
| `run-id` | The ScoutAI run ID |
| `status` | Overall status: `passed` or `failed` |
| `passed` | Number of passed flows |
| `failed` | Number of failed flows |

## How it works

1. **Analyzes your PR** - ScoutAI examines the code diff to understand what changed
2. **Crawls your app** - Discovers real page structure, forms, buttons, and links
3. **Generates tests** - AI creates targeted Playwright tests for the changes
4. **Runs tests** - Executes the tests against your running application
5. **Reports results** - Posts a summary comment on your PR

## Getting Started

1. Sign up at [scoutai.dev](https://scoutai.dev) to get your API key
2. Add `SCOUTAI_API_KEY` to your repository secrets
3. Add the workflow file to `.github/workflows/scoutai.yml`

## License

MIT
