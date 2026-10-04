# Allure TestOps aux utils

A containerized React and Node.js application with auxiliary tools for Allure TestOps. It works only through the public Allure TestOps REST API, on behalf of the owner of the API token entered in the settings.

## Tools

| Tool | State |
| --- | --- |
| [Launch → Allure Report](#launch--allure-report): a launch as a single-file Allure Report 3 | available |
| Test cases → JSON files with attachments, importable back | planned |
| Test cases → Markdown files | planned |
| Markdown files → test cases | planned |
| Gherkin feature files with examples → test cases | planned |
| Launch cleanup | planned |
| Rollback of test case changes made after a point in time | planned |
| Project as a template: a copy of a project with its custom fields, integrations, settings and environments | planned |
| Cleanup of custom field values, environment values and tags, showing the affected entities first | planned |

## Launch → Allure Report

Builds an [Allure Report 3](https://allurereport.org/docs/v3/) from the test results of one launch as one HTML file. The file opens in any browser straight from the disk, without a web server, so it can be attached to a ticket, an email or a CI artifact.

1. Choose a project and a launch. The 50 latest launches are listed with their tags, environment and result counts; the list can be narrowed down by launch ID or part of the name and by a filter (see [Finding the launch](#finding-the-launch)).
2. Set the report options and press **Build report**. Progress is shown while the test results are read; the job keeps running if the page is closed.
3. **Open** shows the report in a new browser tab, **Download** saves the file.

Built files are kept for 24 hours or until deleted with the bin button; restarting the container removes them.

### Finding the launch

The filter is a list of conditions, each on a tag or on one environment variable:

| Condition | AQL |
| --- | --- |
| Tag is / is not `smoke` | `tag = "smoke"`, `tag != "smoke"` |
| Tag is any of / none of `smoke`, `nightly` | `tag in ["smoke", "nightly"]`, `not (tag in ["smoke", "nightly"])` |
| Tag contains `night` | `tag ~= "night"` |
| Tag is not set / is set | `tag = null`, `tag != null` |
| `browser` is / is not / is any of / is none of `chrome` | `ev["browser"] = "chrome"` and so on |
| `os` is not set / is set | `ev["os"] = null`, `ev["os"] != null` |

A launch run in several environments (for example two browsers) matches a condition on a variable when any of its values does, so `browser is chrome` and `browser is firefox` joined with AND find launches run in both. Conditions are joined with AND or OR; as in AQL, AND is applied before OR: `A or B and C` means `A or (B and C)`. Values are suggested from Allure TestOps, any other value can be typed.

The AQL built from the conditions is shown under them. **Edit as AQL** turns it into text for queries the conditions cannot express, such as brackets, `not` around a group, or other launch attributes (`name`, `createdBy`, `createdDate`, `closed`). **Back to conditions** drops the text. The filter is remembered in the browser.

### What gets into the report

| Allure TestOps | Allure Report |
| --- | --- |
| Test result name, full name, status, start, duration | the same; a result still in progress is shown as unknown |
| Message and trace | error and stack trace |
| Flaky, muted and known flags | the same flags |
| Steps with nested steps, step parameters, step errors, expected results | steps; expected results of a step are a nested "Expected result" step |
| Attachments of the test and of its steps | attachments, embedded in the file |
| Fixtures (set up and tear down) with their steps and attachments | Set up and Tear down sections |
| Description, precondition and expected result | description (Markdown), precondition and expected result as sections |
| Parameters, including hidden and excluded ones | parameters; hidden ones are not shown |
| Tags | `tag` labels |
| Layer | `layer` label |
| Custom fields | labels: fields named like Allure labels (Epic, Feature, Story, Suite, Parent Suite, Sub Suite, Package, Severity, Owner…, ignoring case, spaces, dashes and underscores) become those labels, the others keep their names |
| Members (Owner, Lead…) | labels named after the role; Owner becomes `owner` |
| Host and thread | `host` and `thread` labels |
| Links and issues | links; issues are issue links |
| Test case | `ALLURE_ID` label and a link to the test case in Allure TestOps |
| Earlier attempts of retried tests | retries of the test |
| Launch environment | environment of the report |

### Options

- **Report name**: the launch name by default.
- **Group test results by**: suites (parent suite → suite → sub suite), behaviours (epic → feature → story), package, or a flat list. **Auto** takes the first of suites, behaviours and package present in the results.
- **Retries**: include earlier attempts of retried tests.
- **Attachments**: embed attachments; **Skip attachments larger than** keeps the file size under control (0 means no limit). Skipped and failed attachments are listed as warnings of the job.
- **Theme**: light, dark or the viewer's system theme.

### Load on Allure TestOps

Each test result takes five requests (steps, fixtures, custom fields, members, issues) plus one per attachment. At most 8 requests to Allure TestOps run at the same time. Reads that fail with a server error, or get an HTML page instead of JSON, are repeated up to three times; a result whose details still cannot be read gets into the report without them, with a warning.

### Allure TestOps API used

- `GET /api/rs/project`
- `GET /api/rs/launch?projectId=&preview=true`, `GET /api/rs/launch/__search?projectId=&rql=`, `GET /api/rs/launch/query/validate?projectId=&rql=`, `GET /api/rs/launch/{id}`, `GET /api/rs/launch/{id}/env`, `GET /api/rs/launch/{id}/statistic`
- `GET /api/rs/launch/tag/suggest`, `GET /api/rs/ev/suggest`, `GET /api/rs/evv/suggest`
- `GET /api/rs/testresult?launchId=`
- `GET /api/rs/testresult/{id}/execution?v2=true`, `.../fixture?v2=true`, `.../cfv?v2=true`, `.../members`, `.../issue`
- `GET /api/rs/testresult/attachment/{id}/content`, `GET /api/rs/testfixtureresult/attachment/{id}/content`

## Running

With docker compose, pulling the published image from GitHub Container Registry:

```bash
docker compose up -d
```

Open http://localhost:8080. On the **Settings** page enter the Allure TestOps URL and an API token (Allure TestOps user profile → API tokens).

There are two compose files:

| File | Purpose | Image |
| --- | --- | --- |
| `docker-compose.yml` (default) | end users | `ghcr.io/cheshi-mantu/allure-testops-aux-utils`, pulled on every `up` |
| `dev-compose.yml` | development and local runs | built from source, together with a fake Allure TestOps |

A specific release is selected with `AUX_UTILS_TAG` (for example `AUX_UTILS_TAG=0.1.0`, `latest` by default), the host port with `AUX_UTILS_PORT` (8080 by default).

The application has no login of its own and acts with the saved API token, so both compose files publish it on `127.0.0.1` only. Publish it on other interfaces only in a trusted network.

Without compose:

```bash
docker run -d --name allure-testops-aux-utils -p 127.0.0.1:8080:8080 -v aux-utils-data:/app/data ghcr.io/cheshi-mantu/allure-testops-aux-utils:latest
```

### Settings and files

The server keeps the endpoint and the token in `/app/data/config.json` and the files built by the tools in `/app/data/jobs`. Both compose files mount a named volume at `/app/data`, so the settings outlive the container; `docker compose down -v` deletes them. The token is never sent back to the browser: the UI only sees its last 4 characters.

## Development

Node.js 22.12 or newer.

```bash
npm install
npm run dev:mock    # fake Allure TestOps on http://localhost:9090, API token "mock-token"
npm run dev         # API server on :8080 and the UI with hot reload on http://localhost:5173
                    # (PORT=8180 API_PORT=8180 npm run dev when 8080 is taken)
```

`MOCK_PORT` moves the mock to another port. `MOCK_FAILURE_RATE=0.1 npm run dev:mock` makes a share of the mock's reads fail with a 500 or an HTML page, to see how the tools cope with an overloaded server.

```bash
npm run typecheck
npm test            # unit tests and an end-to-end export against the mock
npm run build && npm start
```

With Docker, building from source:

```bash
docker compose -f dev-compose.yml up -d --build
```

```bash
docker compose -f dev-compose.yml run --rm --build tests
```

In the UI at http://localhost:8080 connect to the mock with endpoint `http://mock:9090` and API token `mock-token`.

### Releases

Publishing a GitHub release `vX.Y.Z` builds the image for `linux/amd64` and `linux/arm64` and pushes it to GitHub Container Registry as `X.Y.Z`, `X.Y` and `latest` (a pre-release gets only its exact version).

## License

[Apache License 2.0](LICENSE)
