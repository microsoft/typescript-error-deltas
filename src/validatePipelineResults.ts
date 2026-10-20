import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkerRepos, metadataFileName, resultFileNameSuffix, type Metadata } from "./main.js";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMetadata(value: unknown): value is Metadata {
    return isRecord(value)
        && typeof value.newTsResolvedVersion === "string" && value.newTsResolvedVersion.length > 0
        && typeof value.oldTsResolvedVersion === "string"
        && isRecord(value.statusCounts)
        && Object.values(value.statusCounts).every(isCount);
}

function readJson(file: string): unknown {
    if (!fs.lstatSync(file).isFile()) {
        throw new Error("Expected a regular pipeline result file");
    }
    const text = fs.readFileSync(file, "utf8");
    try {
        return JSON.parse(text);
    }
    catch (error) {
        // Parse errors can quote artifact text containing logging commands.
        if (error instanceof SyntaxError) throw new Error("Invalid JSON in pipeline results");
        throw error;
    }
}

export function readPipelineResults(resultDir: string, workerCount: number): { metadata: Metadata[]; resultPaths: string[] } {
    if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
        throw new Error("Expected a positive pipeline worker count");
    }
    const repos = readJson(path.join(resultDir, "RepoList", "repos.json"));
    if (!Array.isArray(repos) || repos.length === 0) {
        throw new Error("Expected a nonempty pipeline repository list");
    }

    const metadata: Metadata[] = [];
    const resultPaths: string[] = [];
    for (let worker = 1; worker <= workerCount; worker++) {
        const directory = path.join(resultDir, `RepoResults${worker}`);
        if (!fs.lstatSync(directory).isDirectory()) {
            throw new Error("Expected a pipeline result directory");
        }
        const value = readJson(path.join(directory, metadataFileName));
        if (!isMetadata(value)) throw new Error("Invalid pipeline result metadata");
        const count = Object.values(value.statusCounts).reduce((total, count) => total + count, 0);
        if (count !== getWorkerRepos<unknown>(repos, workerCount, worker).length) {
            throw new Error("Pipeline results do not cover all assigned repositories");
        }
        if (metadata.length && (value.newTsResolvedVersion !== metadata[0].newTsResolvedVersion
            || value.oldTsResolvedVersion !== metadata[0].oldTsResolvedVersion)) {
            throw new Error("Pipeline results compare different compiler versions");
        }

        const files = fs.readdirSync(directory, { withFileTypes: true })
            .filter(file => file.name.endsWith(`.${resultFileNameSuffix}`));
        if (files.some(file => !file.isFile())) {
            throw new Error("Expected regular pipeline report files");
        }
        if (value.statusCounts["Detected interesting changes"] && !files.length) {
            throw new Error("Missing reports for detected changes");
        }
        metadata.push(value);
        resultPaths.push(...files.map(file => path.join(directory, file.name)));
    }
    resultPaths.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    return { metadata, resultPaths };
}

if (import.meta.main) {
    if (process.argv.length !== 4) {
        throw new Error("Usage: validatePipelineResults <result_dir_path> <worker_count>");
    }
    readPipelineResults(process.argv[2], Number(process.argv[3]));
    console.log("Validated all pipeline result shards");
}
