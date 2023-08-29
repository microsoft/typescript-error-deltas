import ghLink = require("@typescript/github-link");
import projectGraph = require("./projectGraph");
import { SpawnResult, spawnWithTimeoutAsync } from "./execUtils";
import fs = require("fs");
import path = require("path");

const nodePath = process.argv0;

const errorCodeRegex = /error TS(\d+).*/;
const errorPositionRegex = /^([^(]+)(?:\((\d+),(\d+))/;
const beginProjectRegex = /Building project '([^']+)'/;

interface LocalError {
    projectUrl: string,
    code: number,
    text: string,
    path?: string,
    lineNumber?: number,
    columnNumber?: number,
}

export interface Error {
    /** The URL of the containing project.  May not match the one in ProjectErrors for composite projects. */
    projectUrl: string,
    /** The URL of the containing file, including the line number. */
    fileUrl?: string,
    /** The TypeScript error code. */
    code: number,
    /** The first line of the error message.  No structure guaranteed. */
    text: string,
}

export interface ProjectErrors {
    /** The URL of the root project (i.e. the one to build to repro the errors). */
    projectUrl: string,
    /** True if the root project is composite (i.e. if build mode was used). */
    isComposite: boolean,
    /** True if tsc did not return success. */
    hasBuildFailure: boolean,
    /** Errors extracted from the output of tsc. */
    errors: readonly Error[],
    /** The verbatim output of tsc, for debugging. */
    raw: string,
}

export interface RepoErrors {
    /** True if there was a problem building the project graph from the project files. */
    hasConfigFailure: boolean,
    /** Errors, grouped by root project. */
    projectErrors: readonly ProjectErrors[],
}

export function errorEquals(error1: Error, error2: Error) {
    return error1.code === error2.code
        && error1.fileUrl === error2.fileUrl
        && error1.projectUrl === error2.projectUrl
        && error1.text === error2.text;
}

/**
 * Given a folder and a compiler, identify buildable projects and compile them.
 * Assumes that package installation has already occurred.
 * @param repoDir Typically, the root folder of a git repository.
 * @param tscPath The path to tsc.js.
 * @param skipLibCheck True pass --skipLibCheck when building non-composite projects.  (Defaults to true)
 */
export async function buildAndGetErrors(repoDir: string, monorepoPackages: readonly string[], isUserTestRepo: boolean, tscPath: string, timeoutMs: number, skipLibCheck: boolean = true): Promise<RepoErrors> {
    const projectErrors: ProjectErrors[] = [];
    const tsRepoPath = path.dirname(path.dirname(path.dirname(tscPath)))

    // If it's a user test repo and there's a build.sh in the root, don't bother searching for projects
    // Obviously, we don't want to execute scripts we find in GH repos
    if (isUserTestRepo) {
        const buildScriptPath = path.join(repoDir, "build.sh");
        if (fs.existsSync(buildScriptPath)) {

            const spawnResult = await spawnWithTimeoutAsync(repoDir, path.resolve(buildScriptPath), [], timeoutMs, { ...process.env, TS: tsRepoPath });
            if (!spawnResult) {
                throw new Error(`build.sh timed out after ${timeoutMs} ms`);
            }

            const { isEmpty, stdout, hasBuildFailure } = getBuildSummary(spawnResult);

            if (!isEmpty) {
                projectErrors.push(await getProjectErrors(buildScriptPath, tsRepoPath, stdout, hasBuildFailure, /*isComposite*/ false, /*reportGithubLinks*/ false));
            }

            return {
                hasConfigFailure: false,
                projectErrors,
            };
        }
    }

    const simpleBuildArgs = ["--skipLibCheck", `${skipLibCheck}`, "--incremental", "false", "--pretty", "false", "-p"];
    const compositeBuildArgs = ["-b", "-f", "-v"]; // Build mode doesn't support --skipLibCheck or --pretty

    const { simpleProjects, rootCompositeProjects, hasError: hasConfigFailure } = await projectGraph.getProjectsToBuild(repoDir, monorepoPackages);
    // TODO: Move this inside getProjectsToBuild, separating them is pointless (originally separate to enable simple-only and composite-only runs)
    const projectsToBuild = simpleProjects.concat(rootCompositeProjects);
    if (!projectsToBuild.length) {
        return {
            hasConfigFailure,
            projectErrors,
        };
    }

    const startMs = performance.now();
    for (const { path: projectPath, isComposite } of projectsToBuild) {
        const elapsedMs = performance.now() - startMs;

        const args = ["--max-old-space-size=3072", tscPath, ...(isComposite ? compositeBuildArgs : simpleBuildArgs), path.basename(projectPath)];
        const spawnResult = await spawnWithTimeoutAsync(path.dirname(projectPath), nodePath, args, timeoutMs - elapsedMs);
        if (!spawnResult) {
            throw new Error(`Building ${projectPath} timed out after ${Math.round(timeoutMs - elapsedMs)} ms (of ${timeoutMs} ms for repo)`);
        }

        const { isEmpty, stdout, hasBuildFailure } = getBuildSummary(spawnResult);
        if (isEmpty) continue;

        projectErrors.push(await getProjectErrors(projectPath, tsRepoPath, stdout, hasBuildFailure, isComposite, /*reportGithubLinks*/ !isUserTestRepo));
    }

    return {
        hasConfigFailure,
        projectErrors,
    };
}

async function getProjectErrors(projectPath: string, tsRepoPath: string, stdout: string, hasBuildFailure: boolean, isComposite: boolean, reportGithubLinks: boolean): Promise<ProjectErrors> {
    const projectDir = path.dirname(projectPath);
    const projectUrl = reportGithubLinks ? await ghLink.getGithubLink(projectPath) : projectPath; // Use project path for user tests as they don't contain a git project.

    let localErrors: LocalError[] = [];
    let currProjectUrl = projectUrl;

    const lines = stdout.split(/\r\n?|\n/);
    for (const line of lines) {
        const projectMatch = isComposite && line.match(beginProjectRegex);
        if (projectMatch) {
            currProjectUrl = reportGithubLinks ? await ghLink.getGithubLink(path.resolve(projectDir, projectMatch[1])) : path.resolve(projectDir, projectMatch[1]);
            continue;
        }
        const localError = getLocalErrorFromLine(line, currProjectUrl);
        if (localError) {
            localErrors.push(localError);
        }
    }
    // Handling the project-level errors separately makes it easier to bulk convert the file-level errors to use GH urls
    const errors = localErrors.filter(le => !le.path).map(le => ({ projectUrl: le.projectUrl, code: le.code, text: le.text } as Error));

    const fileLocalErrors = localErrors.filter(le => le.path).map(le => ({ ...le, path: path.resolve(projectDir, le.path!) }));
    const fileUrls = reportGithubLinks ? await ghLink.getGithubLinks(fileLocalErrors) : fileLocalErrors.map(x => `${x.path}(${x.lineNumber},${x.columnNumber})`);
    for (let i = 0; i < fileLocalErrors.length; i++) {
        const localError = fileLocalErrors[i];
        errors.push({
            projectUrl: localError.projectUrl,
            code: localError.code,
            text: localError.text,
            fileUrl: fileUrls[i],
        });
    }

    for (const error of errors) {
        // Drop paths to the repo (e.g., elaborations mentioning lib.d.ts files) so the messages still compare equal.
        if (error.text) {
            // TODO: use replaceAll once that's available.
            error.text = error.text.split(tsRepoPath).join("<ts>");
        }
    }

    return {
        projectUrl,
        isComposite,
        hasBuildFailure,
        errors: errors,
        raw: stdout,
    };
}

function getLocalErrorFromLine(line: string, projectUrl: string): LocalError | undefined {
    const errorCodeMatch = line.match(errorCodeRegex);
    if (errorCodeMatch) {
        const text = errorCodeMatch[0];
        const code = +errorCodeMatch[1];
        const positionMatch = line.match(errorPositionRegex);
        if (positionMatch) {
            const path = positionMatch[1];
            const lineNumber = +positionMatch[2];
            const columnNumber = +positionMatch[3];

            return {
                projectUrl,
                code,
                text,
                path,
                lineNumber,
                columnNumber,
            };
        }
        else {
            return {
                projectUrl,
                code,
                text,
            };
        }
    }

    return undefined;
}

function getBuildSummary({ code, signal, stderr, stdout }: SpawnResult) {
    return {
        stdout,
        hasBuildFailure: !!(code || signal || (stderr && stderr.length && !stderr.match(/debugger/i))), // --inspect prints the debug port to stderr
        isEmpty: !!stdout.match(/TS18003/)
    };
}
