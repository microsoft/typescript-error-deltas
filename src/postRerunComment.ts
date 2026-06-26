import path = require("path");
import fs = require("fs");
import octokit = require("@octokit/rest");
import { LspHarnessOutput, reportError } from "./main";

const { argv } = process;

if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <issue_number> <result_dir_path> <tsgo_version> <post_result>`);
    process.exit(-1);
}

const [,, issueNumberStr, resultDirPath, tsgoVersion, postStr] = argv;
const issueNumber = +issueNumberStr;
const postResult = postStr.toLowerCase() === "true";

interface ReplayResult {
    repo: string;
    repoUrl: string;
    replayScript: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    status: "pass" | "crash" | "error" | "timeout";
}

interface ResultsFile {
    results: ReplayResult[];
    tsgoPath: string;
    issueNumber: number;
}

function parseLspOutput(output: string): LspHarnessOutput | string {
    try {
        const parsed = JSON.parse(output);
        if (parsed.method !== undefined && parsed.message !== undefined) {
            return parsed as LspHarnessOutput;
        }
        return output;
    }
    catch {
        return output;
    }
}

function getErrorSummary(result: ReplayResult): string {
    if (result.status === "pass") return "✅ No crash";
    if (result.status === "timeout") return "⏰ Timeout";

    const parsed = parseLspOutput(result.stdout);
    if (typeof parsed === "string") {
        return parsed.split(/\r?\n/)[0].slice(0, 200) || result.status;
    }

    const firstLine = parsed.message.split(/\r?\n/)[0];
    return firstLine.slice(0, 200);
}

async function main() {
    const resultsPath = path.join(resultDirPath, "results.json");
    if (!fs.existsSync(resultsPath)) {
        console.error(`Results file not found: ${resultsPath}`);
        process.exit(-1);
    }

    const data: ResultsFile = JSON.parse(fs.readFileSync(resultsPath, { encoding: "utf-8" }));
    const { results } = data;

    if (results.length === 0) {
        console.log("No replay results to post");
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

| Repo | Original replay script |
|------|----------------------|
`;
        for (const result of passed) {
            body += `| [${result.repo}](${result.repoUrl}) | \`${result.replayScript}\` |\n`;
        }
        body += "\n";
    }

    if (failed.length > 0) {
        body += `### Still failing

`;
        for (const result of failed) {
            const errorSummary = getErrorSummary(result);
            body += `<details>
<summary>${getStatusEmoji(result.status)} <a href="${result.repoUrl}">${result.repo}</a> — ${errorSummary}</summary>

`;
            if (result.stdout) {
                const parsed = parseLspOutput(result.stdout);
                if (typeof parsed !== "string") {
                    body += `**Method:** \`${parsed.method}\`\n\n`;
                    body += `\`\`\`\n${parsed.message.slice(0, 3000)}\n\`\`\`\n`;
                } else {
                    body += `\`\`\`\n${result.stdout.slice(0, 3000)}\n\`\`\`\n`;
                }
            }
            if (result.stderr && result.status === "timeout") {
                body += `\n${result.stderr}\n`;
            }
            body += `\n</details>\n\n`;
        }
    }

    if (!postResult) {
        console.log("Comment not posted:");
        console.log(body);
        return;
    }

    console.log("Posting rerun results as comment on issue #" + issueNumber);

    // const kit = new octokit.Octokit({
    //     auth: process.env.GITHUB_PAT,
    // });

    const maxCommentLength = 65535;

    if (body.length > maxCommentLength) {
        body = body.slice(0, maxCommentLength - 100) + "\n\n:warning: Comment truncated — see pipeline artifacts for full results.";
    }

    // !!! remove posting to GH for now
    // const response = await kit.issues.createComment({
    //     owner: "microsoft",
    //     repo: "typescript-go",
    //     issue_number: issueNumber,
    //     body,
    // });
    console.log(body);
    console.log(`Posted comment: ${response.data.html_url}`);
}

function getStatusEmoji(status: string): string {
    switch (status) {
        case "crash": return "💥";
        case "error": return "❌";
        case "timeout": return "⏰";
        default: return "❓";
    }
}

main().catch(err => {
    reportError(err, "Unhandled exception in postRerunComment");
    process.exit(1);
});
