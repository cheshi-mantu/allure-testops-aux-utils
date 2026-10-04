# Allure TestOps aux utils

A containerized React and Node.js application with auxiliary tools for Allure TestOps. It works only through the public Allure TestOps REST API, on behalf of the owner of the API token entered in the settings.

## Tools

| Tool | State |
| --- | --- |
| [Launch → Allure Report](#launch--allure-report): a launch as a single-file Allure Report 3 | available |
| [Launch → HTML document](#launch--html-document): a launch as one long HTML page and a PDF | available |
| Test cases → JSON files with attachments, importable back | planned |
| Test cases → Markdown files | planned |
| Markdown files → test cases | planned |
| Gherkin feature files with examples → test cases | planned |
| Launch cleanup | planned |
| Rollback of test case changes made after a point in time | planned |
| [Project as a template](#project-as-a-template): the configuration of a project copied into a new or an existing one | available |
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

## Launch → HTML document

Writes the test results of one launch as one long HTML page and, unless turned off, a PDF with the same content. The launch is chosen the same way as for the Allure report, with the same filter. Both files are offered next to each other in the job: **Open** shows a file in a new browser tab, **Download** saves it.

The page has:

1. **The launch name**, its ID and a link to the launch in Allure TestOps.
2. **Launch attributes**: project, creation time and author, state, the number of test results by status and what was left out; tags, links, and issues with their keys and links to the issue tracker. When the launch was filled by several CI job runs, each job run is listed with its link to CI, stage, status, number of test results and its own environment variables (collected from its test results); otherwise the launch environment is shown.
3. **Contents**: the test results grouped by status (failed, broken, unknown, skipped, passed, in progress), each a link to its section.
4. **Test results**, in the order of the contents. Each one has its name and ID (the anchor the contents link to), a link to the test case and to the test result in Allure TestOps, start, duration and job run; the error (collapsed); a table with the assignee and the tester of a manual test, custom fields, members by role, layer, tags, parameters, the environment variables of the test result, links and issues; the description, precondition and expected result; the scenario with set up and tear down fixtures, nested steps, step parameters and expected results; failed and broken steps are red, with their error collapsed under them; attachments of steps in place, and the test's own attachments in a collapsed section.

Images and text attachments (logs, JSON, XML and so on) are embedded up to the chosen size per attachment and in total; other types (video, archives) and those over the limits are listed by name, type and size. **Expand all** and **Collapse all** open and close every section of the HTML page.

### Printing and PDF

Printed from the browser, the HTML page starts the test results on a new page and every test result on a page of its own; collapsed sections are printed open, also by converters that run no scripts.

The PDF is drawn by the application itself (no browser is involved), on A4 pages:

- the same parts as the HTML page, every test result on a page of its own, everything expanded;
- page numbers at the bottom, entries of the contents link to their test results, bookmarks group the test results by status;
- PNG and JPEG images are embedded; other image formats are mentioned and shown only in the HTML page;
- text attachments are cut at 200 lines; descriptions keep their paragraphs and lists but not their formatting.

Options: which statuses to include (all by default), earlier attempts of retried tests (left out by default), whether to embed attachments, and the size limits.

### Sections

Every test result always has its name, status, ID, links to the test case and the test result, start, duration, job run, error, description, members, tags, parameters and links; a manual test also always has its assignee ("not assigned" when there is none) and, once run, the tester. These sections can be left out:

| Section | What it is |
| --- | --- |
| Scenario | steps, set up and tear down fixtures, with the attachments of steps |
| Custom fields | the custom fields of the test result |
| Environment variables | the environment of the test result (each variable with its values) |
| Attachments | attachments of the test and of its steps |

All sections are on by default. The document says which ones were left out, under **Left out** in the launch attributes. A section left out is not read from Allure TestOps, so the export also gets faster. The chosen options are remembered in the browser.

### Large launches

Both files are written in batches of 100 test results, so the application's memory does not grow with the launch. An export of 20 000 test results from the mock takes under a minute, needs about 200 MB of JavaScript heap and gives a 62 MB HTML page and a PDF of 20 268 pages (79 MB). The image limits the heap to 1024 MB (`AUX_UTILS_HEAP_MB` in `docker-compose.yml`). Reading takes up to 6 requests per test result (fewer with sections left out), at most 8 at a time, so tens of thousands of test results take minutes on a real instance. The browser shows such a page well: sections off screen are not laid out until scrolled to. For a PDF that people will actually read, choose the statuses that matter (for example failed and broken).

### Allure TestOps API used

The same as for the Allure report, and also:

- `GET /api/rs/project/{id}`
- `GET /api/rs/launch/{id}/job`
- `GET /api/rs/testresult/{id}/evv`
- the fields `manual`, `assignee`, `assigneeUser`, `testedBy` and `testedByUser` of `GET /api/rs/testresult?launchId=`

Links in the document lead to `<endpoint>/launch/{id}`, `<endpoint>/testresult/{id}` and `<endpoint>/project/{projectId}/test-cases/{id}`.

## Project as a template

Copies the configuration of a project (not its test cases, launches or results) into a new project or into an existing one.

1. Choose the source project and the target: a new project (name, abbreviation, description, public or not) or an existing one. Project names are unique in Allure TestOps, so the preview refuses a name another project has.
2. Tick the sections to copy.
3. **Preview** reads both projects and lists, section by section, what will be created, updated, removed, what is already the same and what has to be done by hand. Nothing is changed.
4. **Copy** asks for confirmation and runs as a job. Its summary shows the counts per section and a link to the target project; the full list of actions with their outcomes can be downloaded as JSON.

| Section | What is copied |
| --- | --- |
| Project settings | launch auto close and live doc settings, user display mode, project properties, labels with their values, release statuses and workflows (with the default one), cleanup rules, test case update policy |
| Custom fields | custom fields of the project with their project values, required, locked and default value; mapping of result labels to custom fields |
| Environments | mapping of result environment keys to environment variables |
| Workflows | workflows of manual and automated test cases |
| Test layers | mapping of result layer keys to test layers |
| Roles | mapping of result member keys to roles |
| Defect categories | shared categories and matchers are attached, the project's own are recreated |
| Integrations | integrations linked to the project with their project settings, issue and test key mappings, export settings |
| Webhooks | notification webhooks with headers, events and their enabled state |
| Test case trees | trees by custom fields |
| Shared filters | shared filters of test cases, launches and test results |
| Dashboards | dashboards with their widgets, copied by Allure TestOps itself |
| Access | groups and users with their permission sets |

How entries are matched and changed:

- Entries are matched by name, key or code. What the target lacks is created, what differs is updated, what is the same is left alone. Running the template again does only what is still left, so a run interrupted by errors can simply be repeated.
- A new project comes with defaults of Allure TestOps (a few custom fields, environment and role mappings, workflows, trees, release statuses). Those the source does not have are removed, so the new project ends up like the source. In an existing project nothing is removed.
- Custom fields, environment variables, workflows, test layers, roles and integrations themselves are shared by the whole instance: the template links the same ones to the target, it does not duplicate them.
- Allure TestOps creates some entries by itself: writing a project setting (launch auto close, live doc, user display mode) also stores it as project properties. Project properties are therefore copied before the settings, and whenever creating an entry fails, the target is read again: an entry that is there by now is updated instead of being reported as failed.
- A write that fails is not repeated, since Allure TestOps may have done it anyway; it is reported as failed and the next run picks it up.

CI jobs are not copied: set them up in the target project when it is to run tests from a build server.

Some differences are left to be done by hand, and the preview says so:

- a default value of a custom field cannot be cleared through the API: if the target has one and the source does not, clear it in the project settings;
- a custom field can be locked only when it has values in the project;
- a custom field a tree of the project uses cannot be removed from the project: a default field of a new project that the source lacks stays while a tree still uses it (copy the trees too, and it goes).

Some writes are checked by Allure TestOps against the outside world and may be refused: export settings of an integration are verified with the external system, and a webhook endpoint that resolves to a private address or does not resolve at all is rejected. Such actions are reported as failed with the reason.

What cannot be copied, because Allure TestOps does not give it out:

- project-level secrets of integrations: the target uses the integration's default secret until one is set in its settings;
- filters other users keep private;
- dashboards already present in the target under the same name are not overwritten.

The API token owner keeps the access they get as the creator of a new project.

### Allure TestOps API used

`/api/rs/project`, `/projectsettings/*`, `/projectproperty`, `/project/{id}/label`, `/project/release-status`, `/project/release-workflow`, `/cleanerschema`, `/testcaseupdateschema`, `/project/{id}/cf`, `/cfproject/add-to-project`, `/cfproject/remove`, `/project/{id}/cfv`, `/cfschema`, `/evschema`, `/workflowschema`, `/testlayerschema`, `/roleschema`, `/project/{id}/category`, `/category`, `/project/{id}/categorymatcher`, `/categorymatcher`, `/integration/project`, `/issueschema`, `/testkeyschema`, `/integration/export`, `/notification/webhook`, `/tree`, `/filter`, `/dashboard`, `/project/access/{id}/group`, `/project/access/{id}/collaborator`, all under `/api/rs`, and `/api/uaa/account/me`.

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

`MOCK_PORT` moves the mock to another port, `MOCK_LARGE_LAUNCH=20000` adds a launch with that many test results to the "Mobile App" project. `MOCK_FAILURE_RATE=0.1 npm run dev:mock` makes a share of the mock's reads fail with a 500 or an HTML page, to see how the tools cope with an overloaded server.

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
