# MCP GitHub Bridge

A Model Context Protocol (MCP) server that provides GitHub API integration tools for AI assistants and development workflows. This server exposes GitHub functionality through a standardized MCP interface, enabling AI tools to interact with GitHub repositories, pull requests, and related data.

## Features

This MCP server provides the following tools:

### 1. `github_list_repos`
List repositories accessible by the authenticated user.

**Parameters:**
- `visibility` (optional): Filter by visibility (`all`, `public`, `private`)
- `per_page` (optional): Number of results per page (1-100, default: 100)

### 2. `github_list_pull_requests`
List pull requests for a specific repository.

**Parameters:**
- `owner` (required): Repository owner/organization
- `repo` (required): Repository name
- `state` (optional): Filter by state (`open`, `closed`, `all`, default: `open`)
- `per_page` (optional): Number of results per page (1-100, default: 30)

### 3. `github_get_pull_request_diff`
Retrieve the complete unified diff for a pull request (similar to `git diff`).

**Parameters:**
- `pr_url` (required): Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`)
- `max_diff_chars` (optional): Maximum characters to return (0-200000, default: 40000)

### 4. `github_summarize_pull_request`
Generate structured material for summarizing a pull request, including title, objective, changes, files, risks, and more.

**Parameters:**
- `pr_url` (required): Full GitHub PR URL
- `include_patches` (optional): Include file patches (default: `true`)
- `max_files` (optional): Maximum number of files to include (1-300, default: 50)
- `max_patch_chars` (optional): Maximum characters per patch (0-4000, default: 2000)
- `include_diff` (optional): Include unified diff (default: `false`)
- `max_diff_chars` (optional): Maximum characters for diff (0-200000, default: 40000)

## Local Development

### Prerequisites

- Node.js 22.15.1 or higher
- npm or pnpm
- GitHub Personal Access Token with appropriate permissions

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd mcp-github-bridge
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```bash
GH_PERSONAL_ACCESS_TOKEN=your_github_token_here
```

4. Start the server:
```bash
npm start
```

The server will start on `http://localhost:3333` (or the port specified by the `PORT` environment variable).

### Environment Variables

- `GH_PERSONAL_ACCESS_TOKEN` (required): GitHub Personal Access Token with permissions to access repositories and pull requests
- `PORT` (optional): Server port (default: 3333)

## Deployment

This application is deployed on [Fly.io](https://fly.io) and automatically deploys via GitHub Actions when changes are pushed to the `main` branch.

### Fly.io Configuration

The application is configured via `fly.toml`:

- **App Name**: `mcp-gh-bridge`
- **Primary Region**: `gru` (São Paulo, Brazil)
- **Internal Port**: 3333
- **Memory**: 256MB
- **CPUs**: 1
- **Auto-scaling**: Machines auto-stop when idle and auto-start on request
- **HTTPS**: Force HTTPS enabled

### Deployment Process

1. **Automatic Deployment**: Pushes to the `main` branch trigger a GitHub Actions workflow that deploys to Fly.io
2. **Manual Deployment**: Use the Fly.io CLI:
   ```bash
   flyctl deploy
   ```

### Setting Environment Variables on Fly.io

Set the GitHub token as a secret on Fly.io:

```bash
flyctl secrets set GH_PERSONAL_ACCESS_TOKEN=your_token_here
```

### GitHub Actions Workflow

The deployment workflow (`.github/workflows/fly-deploy.yml`) automatically:
- Checks out the code
- Sets up Fly.io CLI
- Deploys using `flyctl deploy --remote-only`

**Required Secret**: `FLY_API_TOKEN` must be configured in GitHub repository secrets.

## API Endpoints

### MCP Endpoint
- **POST** `/mcp` - Main MCP protocol endpoint for tool execution

### Health Check
- **GET** `/` - Returns `OK - github-mcp` to verify the server is running

## Architecture

- **Framework**: Express.js
- **Protocol**: Model Context Protocol (MCP) SDK
- **Transport**: StreamableHTTPServerTransport (stateless, per-request)
- **Validation**: Zod for parameter validation
- **API Client**: Native `fetch` with GitHub API v3

## Docker

The application includes a multi-stage Dockerfile optimized for production:

- Uses Node.js 22.15.1 slim image
- Multi-stage build to minimize final image size
- Production environment configuration
- Exposes port 3333

## License

ISC
