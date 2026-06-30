import path = require("path");
import fs = require("fs");
import octokit = require("@octokit/rest");
import { execAsync, spawnWithTimeoutAsync } from "./utils/execUtils";
import { downloadTsPrAsync, reportError } from "./main";
import { EXIT_SERVER_CRASH, EXIT_SERVER_EXIT_FAILED } from "./utils/exerciseServerConstants";

const processCwd = process.cwd();
const executionTimeout = 10 * 60 * 1000;

interface RerunParams {
    issueNumber: number;
    /** Either a pre-built tsgo path, or a git ref to build from */
    newTsNpmVersion: string;
    resultDirName: string;
    diagnosticOutput: boolean;
    /** If provided, use this path directly instead of building tsgo */
    tsgoPath?: string;
}

interface RepoInfo {
    repoUrl: string;
    owner: string;
    repoName: string;
    commit: string | undefined;
    lastFewRequests: string;
}

export interface ReplayResult {
    repo: string;
    repoUrl: string;
    replayScript: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    status: "pass" | "crash" | "error" | "timeout";
}

export async function rerunFromIssueAsync(params: RerunParams): Promise<void> {
    const { issueNumber, resultDirName, diagnosticOutput } = params;

    const resultDirPath = path.join(processCwd, resultDirName);
    if (!(await exists(resultDirPath))) {
        await fs.promises.mkdir(resultDirPath, { recursive: true });
    }

    // Build or resolve tsgo path
    let tsgoPath: string;
    if (params.tsgoPath) {
        tsgoPath = params.tsgoPath;
    } else {
        console.log(`Building tsgo from ref ${params.newTsNpmVersion}...`);
        const { tsEntrypointPath } = await downloadTsPrAsync(
            processCwd,
            "https://github.com/microsoft/typescript-go.git",
            params.newTsNpmVersion as unknown as number, // TypeScript PR numbers are numeric
            "fuzzer",
            true,
        );
        tsgoPath = tsEntrypointPath;
    }
    console.log(`Using tsgo at: ${tsgoPath}`);

    // 1. Read the issue body and comments from GitHub
    const kit = new octokit.Octokit({ auth: process.env.GITHUB_PAT });

    console.log(`Reading issue #${issueNumber}...`);
    const issue = await kit.issues.get({
        owner: "microsoft",
        repo: "typescript-go",
        issue_number: issueNumber,
    });

    const comments = await kit.paginate(kit.issues.listComments, {
        owner: "microsoft",
        repo: "typescript-go",
        issue_number: issueNumber,
        per_page: 100,
    });

    const allBodies = [issue.data.body ?? "", ...comments.map(c => c.body ?? "")];

    // 2. Parse repo info from the issue
    const repos = parseReposFromIssue(allBodies);

    if (repos.length === 0) {
        console.log("No repos with replay data found in issue");
        await fs.promises.writeFile(path.join(resultDirPath, "results.json"), JSON.stringify({ results: [], tsgoPath, issueNumber }), { encoding: "utf-8" });
        return;
    }

    console.log(`Found ${repos.length} repo(s) to replay`);

    // 3. Set up download directory for repos
    const downloadDir = path.join(processCwd, "rerun_downloads");
    await fs.promises.mkdir(downloadDir, { recursive: true });

    // 4. Replay each repo
    const results: ReplayResult[] = [];

    for (const repo of repos) {
        console.log(`\n--- Replaying ${repo.owner}/${repo.repoName} ---`);
        console.log(`  Repo URL: ${repo.repoUrl}`);
        console.log(`  Commit: ${repo.commit ?? "HEAD"}`);

        // Clone the repo
        const repoDir = path.join(downloadDir, repo.repoName);
        if (!(await exists(repoDir))) {
            let cloned = false;
            try {
                console.log(`  Cloning ${repo.repoUrl}...`);
                await execAsync(downloadDir, `git clone ${repo.repoUrl} ${repo.repoName} --recurse-submodules --depth=1`);
                cloned = true;
            } catch {
                // Shallow clone may fail for some repos; try full clone
                try {
                    await execAsync(downloadDir, `git clone ${repo.repoUrl} ${repo.repoName} --recurse-submodules`);
                    cloned = true;
                } catch (err) {
                    console.error(`  Failed to clone ${repo.repoUrl}`);
                    results.push({
                        repo: `${repo.owner}/${repo.repoName}`,
                        repoUrl: repo.repoUrl,
                        replayScript: "(from issue)",
                        exitCode: -1,
                        signal: null,
                        stdout: "",
                        stderr: `Clone failed: ${err}`,
                        status: "error",
                    });
                    continue;
                }
            }

            // Reset to the specific commit if we have one
            if (cloned && repo.commit) {
                try {
                    await execAsync(repoDir, `git fetch origin ${repo.commit}`);
                    await execAsync(repoDir, `git reset --hard ${repo.commit}`);
                } catch {
                    console.log(`  Could not reset to commit ${repo.commit}, using HEAD`);
                }
            }
        }

        // Build a replay script from the last few requests
        const replayScriptPath = path.join(downloadDir, `${repo.owner}.${repo.repoName}.replay.txt`);
        const replayContent = buildReplayScript(repo.lastFewRequests, repoDir);
        await fs.promises.writeFile(replayScriptPath, replayContent, { encoding: "utf-8" });

        if (diagnosticOutput) {
            console.log(`  Replay script (${replayContent.split("\n").length} lines):`);
            console.log(`  ${replayContent.slice(0, 500)}`);
        }

        // Run the replay
        const result = await runReplay(repoDir, replayScriptPath, tsgoPath, diagnosticOutput);
        results.push({
            repo: `${repo.owner}/${repo.repoName}`,
            repoUrl: repo.repoUrl,
            replayScript: "(from issue)",
            ...result,
        });

        console.log(`  Result: ${result.status} (exit code: ${result.exitCode})`);
        if (diagnosticOutput && result.stdout) {
            console.log(`  stdout: ${result.stdout.slice(0, 500)}`);
        }
    }

    // 5. Write results
    const outputPath = path.join(resultDirPath, "results.json");
    await fs.promises.writeFile(outputPath, JSON.stringify({ results, tsgoPath, issueNumber }, undefined, 2), { encoding: "utf-8" });
    console.log(`\nResults written to ${outputPath}`);

    // Summary
    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status !== "pass").length;
    console.log(`\nSummary: ${passed} passed, ${failed} failed out of ${results.length} total`);

    // 6. Post results as comment on the issue
    await postRerunResults(kit, issueNumber, params.newTsNpmVersion, results);
}

async function postRerunResults(kit: InstanceType<typeof octokit.Octokit>, issueNumber: number, tsgoVersion: string, results: ReplayResult[]): Promise<void> {
    if (results.length === 0) {
        console.log("No results to post");
        return;
    }

    const passed = results.filter(r => r.status === "pass");
    const failed = results.filter(r => r.status !== "pass");

    let body = `## Rerun results with \`${tsgoVersion}\`

Replayed ${results.length} test(s) from the original run.

| Status | Count |
|--------|-------|
| ✅ Pass (no crash) | ${passed.length} |
| ❌ Still failing | ${failed.length} |

`;

    if (passed.length > 0) {
        body += `### Fixed (no longer crashing)

| Repo | Replay |
|------|--------|
`;
        for (const result of passed) {
            body += `| [${result.repo}](${result.repoUrl}) | ${result.replayScript} |\n`;
        }
        body += "\n";
    }

    if (failed.length > 0) {
        body += `### Still failing

`;
        for (const result of failed) {
            body += `<details>
<summary>${result.status === "crash" ? "💥" : result.status === "timeout" ? "⏰" : "❌"} <a href="${result.repoUrl}">${result.repo}</a> — ${result.status}</summary>

`;
            if (result.stdout) {
                body += `\`\`\`\n${result.stdout.slice(0, 3000)}\n\`\`\`\n`;
            }
            if (result.stderr && result.status === "timeout") {
                body += `\n${result.stderr}\n`;
            }
            body += `\n</details>\n\n`;
        }
    }

    console.log("Posting rerun results as comment on issue #" + issueNumber);

    const maxCommentLength = 65535;
    if (body.length > maxCommentLength) {
        body = body.slice(0, maxCommentLength - 100) + "\n\n:warning: Comment truncated — see pipeline artifacts for full results.";
    }

    // !!! dont post issue during testing
    // const response = await kit.issues.createComment({
    //     owner: "microsoft",
    //     repo: "typescript-go",
    //     issue_number: issueNumber,
    //     body,
    // });

    // console.log(`Posted comment: ${response.data.html_url}`);
}

/**
 * Parses repo information from the issue body and comments.
 *
 * Each repo section in the issue looks like:
 * ```
 * <details>
 * <summary><a href="https://github.com/owner/name">owner/name</a></summary>
 * ...
 * <h4>Last few requests</h4>
 *
 * ```json
 * {"kind":"request",...}
 * ```
 *
 * <h4>Repro steps</h4>
 *
 * ```bash
 * git clone URL --recurse-submodules
 * git -C "./name" reset --hard COMMIT_SHA
 * ...
 * ```
 * </details>
 * ```
 */
function parseReposFromIssue(bodies: string[]): RepoInfo[] {
    const repos: RepoInfo[] = [];
    const seen = new Set<string>();

    for (const text of bodies) {
        // Match each repo's <details> block that contains "Last few requests"
        const repoBlockRegex = /<details>\s*\n\s*<summary><a href="(https:\/\/github\.com\/([^/]+)\/([^"]+))">[^<]*<\/a><\/summary>([\s\S]*?)<\/details>/g;

        let match;
        while ((match = repoBlockRegex.exec(text)) !== null) {
            const [, repoUrl, owner, repoName, blockContent] = match;

            // Skip if no "Last few requests" section
            if (!blockContent.includes("Last few requests")) continue;

            // Extract the last few requests JSON block
            const requestsMatch = /Last few requests<\/h4>\s*\n\s*```json\s*\n([\s\S]*?)```/.exec(blockContent);
            if (!requestsMatch) continue;

            const lastFewRequests = requestsMatch[1].trim();
            if (!lastFewRequests) continue;

            // Extract commit SHA from repro steps
            const commitMatch = /reset --hard ([a-f0-9]+)/.exec(blockContent);
            const commit = commitMatch?.[1];

            const key = `${owner}/${repoName}`;
            if (seen.has(key)) continue;
            seen.add(key);

            repos.push({ repoUrl, owner, repoName, commit, lastFewRequests });
        }
    }

    return repos;
}

/**
 * Builds a minimal replay script that:
 * 1. Starts with the config header
 * 2. Sends initialize/initialized
 * 3. Opens any files referenced in the last few requests (reading content from disk)
 * 4. Sends the last few requests
 * 5. Shuts down the server
 */
function buildReplayScript(lastFewRequests: string, repoDir: string): string {
    const rootDirUri = "@PROJECT_ROOT_URI@";
    const rootDir = "@PROJECT_ROOT@";

    const lines: string[] = [];

    // Config header
    lines.push(JSON.stringify({
        rootDirUriPlaceholder: rootDirUri,
        rootDirPlaceholder: rootDir,
        serverArgs: ["--lsp", "--stdio"],
    }));

    // Initialize request
    lines.push(JSON.stringify({
        kind: "request",
        method: "initialize",
        params: {
            processId: null,
            capabilities: {
                textDocument: {
                    completion: { completionItem: { snippetSupport: true } },
                    definition: { linkSupport: true },
                    hover: { contentFormat: ["markdown", "plaintext"] },
                    diagnostic: { relatedDocumentSupport: true },
                },
                workspace: {},
            },
            rootUri: rootDirUri,
        },
    }));

    // Initialized notification
    lines.push(JSON.stringify({ kind: "notification", method: "initialized", params: {} }));

    // Find all file URIs referenced in the last few requests and open them
    const requestLines = lastFewRequests.split(/\r?\n/).filter(l => l.trim());
    const fileUris = new Set<string>();

    for (const line of requestLines) {
        const uriMatches = line.matchAll(/@PROJECT_ROOT_URI@\/[^"\\]*/g);
        for (const m of uriMatches) {
            fileUris.add(m[0]);
        }
    }

    // For each unique file, send a didOpen with its content read from disk
    for (const fileUri of fileUris) {
        const relativePath = fileUri.replace(`${rootDirUri}/`, "");
        const absolutePath = path.join(repoDir, relativePath);

        let content: string;
        try {
            content = fs.readFileSync(absolutePath, { encoding: "utf-8" });
            // Strip BOM to match VS Code / exerciseLspServer behavior
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }
        } catch {
            console.log(`  Warning: could not read ${relativePath}, skipping didOpen`);
            continue;
        }

        const ext = path.extname(relativePath).toLowerCase();
        const languageId = ext === ".tsx" ? "typescriptreact"
            : ext === ".jsx" ? "javascriptreact"
            : ext === ".js" || ext === ".mjs" || ext === ".cjs" ? "javascript"
            : "typescript";

        lines.push(JSON.stringify({
            kind: "notification",
            method: "textDocument/didOpen",
            params: {
                textDocument: {
                    uri: fileUri,
                    languageId,
                    version: 1,
                    text: content,
                },
            },
        }));
    }

    // Add the last few request lines from the issue
    for (const line of requestLines) {
        lines.push(line);
    }

    // Shutdown and exit
    lines.push(JSON.stringify({ kind: "request", method: "shutdown" }));
    lines.push(JSON.stringify({ kind: "notification", method: "exit" }));

    return lines.join("\n") + "\n";
}

async function runReplay(repoDir: string, replayScriptPath: string, tsgoPath: string, diagnosticOutput: boolean): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; status: "pass" | "crash" | "error" | "timeout" }> {
    const replayServerScript = path.join(__dirname, "utils", "replayLspServer.js");

    const spawnResult = await spawnWithTimeoutAsync(
        repoDir,
        process.argv[0],
        [replayServerScript, repoDir, replayScriptPath, tsgoPath, diagnosticOutput.toString()],
        executionTimeout,
    );

    if (!spawnResult) {
        return {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: `Timed out after ${executionTimeout} ms`,
            status: "timeout",
        };
    }

    let status: "pass" | "crash" | "error";
    if (spawnResult.code === 0) {
        status = "pass";
    } else if (spawnResult.code === EXIT_SERVER_CRASH || spawnResult.code === EXIT_SERVER_EXIT_FAILED) {
        status = "crash";
    } else {
        status = "error";
    }

    return {
        exitCode: spawnResult.code,
        signal: spawnResult.signal,
        stdout: spawnResult.stdout,
        stderr: spawnResult.stderr,
        status,
    };
}

async function exists(p: string): Promise<boolean> {
    return new Promise(resolve => fs.exists(p, e => resolve(e)));
}

// CLI entrypoint
if (require.main === module) {
    const { argv } = process;

    if (argv.length !== 6) {
        console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <issue_number> <tsgo_path> <result_dir_name> <diagnostic_output>`);
        process.exit(-1);
    }

    const [,, issueNumberStr, tsgoPath, resultDirName, diagnosticOutputStr] = argv;

    rerunFromIssueAsync({
        issueNumber: +issueNumberStr,
        newTsNpmVersion: "",
        tsgoPath,
        resultDirName,
        diagnosticOutput: diagnosticOutputStr.toLowerCase() === "true",
    }).catch(err => {
        reportError(err, "Unhandled exception in rerunFromIssue");
        process.exit(1);
    });
}
