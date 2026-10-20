import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readPipelineResults } from "../src/validatePipelineResults.js";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(workers = 2, repoCount = 3) {
    const testRoot = path.join(process.cwd(), "testDownloads");
    fs.mkdirSync(testRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(testRoot, "pipeline-results-"));
    directories.push(root);
    fs.mkdirSync(path.join(root, "RepoList"));
    fs.writeFileSync(path.join(root, "RepoList", "repos.json"), JSON.stringify(
        Array.from({ length: repoCount }, (_, i) => ({ name: `repo${i}` }))));
    const batchSize = Math.ceil(repoCount / workers);
    for (let i = 1; i <= workers; i++) {
        const directory = path.join(root, `RepoResults${i}`);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({
            oldTsResolvedVersion: "baseline",
            newTsResolvedVersion: "candidate",
            prngSeed: "seed",
            statusCounts: {
                "Detected no interesting changes": Math.max(0, Math.min(batchSize, repoCount - (i - 1) * batchSize)),
            },
        }));
    }
    return root;
}

describe("pipeline result validation", () => {
    it("accepts complete clean results, including empty shards, without requiring diagnostics", () => {
        const results = readPipelineResults(fixture(4), 4);
        expect(results.metadata).toHaveLength(4);
        expect(results.resultPaths).toEqual([]);
    });

    it("does not read reports from unexpected artifacts", () => {
        const root = fixture();
        fs.writeFileSync(path.join(root, "RepoList", "unexpected.results.txt"), "not a result");
        expect(readPipelineResults(root, 2).resultPaths).toEqual([]);
    });

    it.each(["directory", "metadata"])("rejects a missing result %s", missing => {
        const root = fixture();
        if (missing === "directory") fs.renameSync(path.join(root, "RepoResults2"), path.join(root, "unexpected"));
        else fs.unlinkSync(path.join(root, "RepoResults2", "metadata.json"));
        expect(() => readPipelineResults(root, 2)).toThrow();
    });

    it.each([
        { statusCounts: {} },
        { statusCounts: { "Detected no interesting changes": 1 } },
        { statusCounts: { "Detected no interesting changes": -1 } },
        { statusCounts: { "Detected interesting changes": 2 } },
        { newTsResolvedVersion: "different compiler" },
        { newTsResolvedVersion: null },
    ])("rejects incomplete or invalid shard data: %j", change => {
        const root = fixture();
        const file = path.join(root, "RepoResults1", "metadata.json");
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...change }));
        expect(() => readPipelineResults(root, 2)).toThrow();
    });

    it("preserves diagnostic text containing inline logging commands", () => {
        const root = fixture();
        const file = path.join(root, "RepoResults1", "repo.results.txt");
        const text = "error TS2741: Property '##vso[task.debug]external' is missing";
        fs.writeFileSync(file, text);
        const results = readPipelineResults(root, 2);
        expect(results.resultPaths).toEqual([file]);
        expect(fs.readFileSync(results.resultPaths[0], "utf8")).toBe(text);
    });

    it("rejects symlinked metadata instead of following it", () => {
        const root = fixture();
        const file = path.join(root, "RepoResults1", "metadata.json");
        fs.renameSync(file, `${file}.original`);
        fs.symlinkSync(`${file}.original`, file);
        expect(() => readPipelineResults(root, 2)).toThrow("Expected a regular pipeline result file");
    });

    it("fails the CLI without echoing logging commands from malformed metadata", () => {
        const root = fixture();
        fs.writeFileSync(path.join(root, "RepoResults1", "metadata.json"),
            "##vso[task.complete result=Succeeded;done=true;]injected");
        const result = spawnSync(process.execPath, ["dist/validatePipelineResults.js", root, "2"], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Invalid JSON in pipeline results");
        expect(result.stdout + result.stderr).not.toContain("##vso[");
    });

    it.each(["postGithubComments", "postGithubIssue"])("%s reports clean results but refuses incomplete results", program => {
        const root = fixture();
        const args = program === "postGithubComments"
            ? ["tsc", "requester", "1", "2", "id", "false", root, "artifacts", "false", "3", "api", "2"]
            : ["tsc", "TypeScript", "3", "0", root, "logs", "artifacts", "false", "api", "2"];
        const run = () => spawnSync(process.execPath, [`dist/${program}.js`, ...args], { encoding: "utf8" });
        const complete = run();
        expect(complete.status, complete.stderr).toBe(0);
        expect(complete.stdout).toContain(program === "postGithubComments"
            ? "Everything looks good!" : "Successfully analyzed 3 of 3 visited repos");

        fs.unlinkSync(path.join(root, "RepoResults2", "metadata.json"));
        const incomplete = run();
        expect(incomplete.status).toBe(1);
        expect(incomplete.stdout).not.toContain("Everything looks good!");
        expect(incomplete.stdout).not.toContain("Issue not posted:");
    });
});
