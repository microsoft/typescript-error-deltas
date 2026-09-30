import { detectTypeScriptImplementation, detectTypeScriptNpmImplementation, downloadTsPrAsync, downloadTsRepoAsync, mainAsync, reduceSpew } from '../src/main.js'
import * as path from "node:path"
import { execFileAsync } from '../src/utils/execUtils.js';
import type { SpawnResult } from '../src/utils/execUtils.js';
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
    typeScriptSpawnResult: undefined as ((args: readonly string[]) => SpawnResult) | undefined,
    writeFile: vi.fn(),
    prRefs: undefined as string | undefined,
}));

vi.mock('random-seed', () => ({
    default: {
        create: () => {
            return {
                random: () => 1,
                seed: () => { },
                string: () => ''
            };
        },
    },
}));
vi.mock("../src/utils/packageUtils", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        exists: vi.fn((filePath: string) => filePath.includes("testDownloads")
            ? fs.existsSync(filePath)
            : Promise.resolve(true)),
        getMonorepoOrder: vi.fn().mockResolvedValue([
            "./dirA/package.json",
            "./dirB/dirC/package.json",
            "./dirD/DirE/dirF/package.json"
        ]),
    };
});
vi.mock("../src/utils/execUtils", () => ({
    spawnWithTimeoutAsync: vi.fn((cwd: string, command: string, args: readonly string[], timeoutMs: number, env?: {}) => {
        if (command === 'npm') {
            // Return nothing so that npm install appears successfull.
            return {};
        }

        return testState.typeScriptSpawnResult!(args);
    }),
    execFileAsync: vi.fn(async (cwd: string, command: string, args: readonly string[] = []) => {
        if (command === "npm" && args[0] === "pack" && args[1] === "typescript@latest") {
            return ' typescript-0.0.0.tgz';
        } else if (command === "npm" && args[0] === "pack" && args[1] === "typescript@next") {
            return ' typescript-1.1.1.tgz';
        } else if (command === "git" && args[0] === "rev-parse") {
            return testState.prRefs ?? '57b462387e88aa7e363af0daf867a5dc1e83a935';
        }

        return '';
    }),
    execFileWithRetryAsync: vi.fn().mockResolvedValue(''),

}));
vi.mock('node:fs', async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        ...fs,
        promises: {
            ...fs.promises,
            writeFile: testState.writeFile,
            copyFile: vi.fn(),
            rm: vi.fn().mockResolvedValue(undefined),
            mkdir: vi.fn().mockResolvedValue(undefined),
            rename: vi.fn().mockResolvedValue(undefined),
            readFile: vi.fn((filePath: string, options?: Parameters<typeof fs.promises.readFile>[1]) => {
            if (/typescript-(?:0\.0\.0|1\.1\.1)[\\/]package\.json$/.test(filePath)) {
                return Promise.resolve(JSON.stringify({ name: "typescript" }));
            }
                return fs.promises.readFile(filePath, options);
            }),
        },
        readFileSync: (path: string) => {
            if (path.endsWith("replay.txt")) {
                return '{\"rootDirPlaceholder\":\"@PROJECT_ROOT@\",\"serverArgs\":[\"--disableAutomaticTypingAcquisition\"]}\r\n{\"seq\":1,\"type\":\"request\",\"command\":\"configure\",\"arguments\":{\"preferences\":{\"disableLineTextInReferences\":true,\"includePackageJsonAutoImports\":\"auto\",\"includeCompletionsForImportStatements\":true,\"includeCompletionsWithSnippetText\":true,\"includeAutomaticOptionalChainCompletions\":true,\"includeCompletionsWithInsertText\":true,\"includeCompletionsWithClassMemberSnippets\":true,\"allowIncompleteCompletions\":true,\"includeCompletionsForModuleExports\":false},\"watchOptions\":{\"excludeDirectories\":[\"**/node_modules\"]}}}\r\n{\"seq\":2,\"type\":\"request\",\"command\":\"updateOpen\",\"arguments\":{\"changedFiles\":[],\"closedFiles\":[],\"openFiles\":[{\"file\":\"@PROJECT_ROOT@/sample_repoName.config.js\",\"projectRootPath\":\"@PROJECT_ROOT@\"}]}}\r\n{\"seq\":3,\"type\":\"request\",\"command\":\"cursedCommand\",\"arguments\":{\"file\":\"@PROJECT_ROOT@/src/sampleTsFile.ts\",\"line\":1,\"offset\":1,\"includeExternalModuleExports\":false,\"triggerKind\":1}}';
            }
            if (path.endsWith('repos.json')) {
                return JSON.stringify([{
                    "url": "https://github.com/MockRepoOwner/MockRepoName",
                    "name": "MockRepoName",
                    "owner": "MockRepoOwner"
                }]);
            }
            return fs.readFileSync(path);
        },
    };
});
vi.mock('@typescript/server-replay/installPackages', () => {
    return {
        installDependencies: vi.fn().mockResolvedValue(undefined),
    }
});

const errorStdout = JSON.stringify({
    "request_seq": "123",
    "command": "cursedCommand",
    "message": "Some error. Could not do something. \nMaybe a Debug fail.\n    at a (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:1:1)\n    at b (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:2:2)\n    at c (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:3:3)\n    at d (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:4:4)\n    at e (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:5:5)"
});

describe("main", () => {
    it("detects tsgo from the root package name", () => {
        expect(detectTypeScriptImplementation({ name: "typescript" })).toBe("strada");
        expect(detectTypeScriptImplementation({ name: "typescript-go" })).toBe("corsa");
        expect(detectTypeScriptImplementation({ name: "@typescript/repo" })).toBe("corsa");
    });

    it("detects Corsa npm packages from their platform dependencies", () => {
        expect(detectTypeScriptNpmImplementation({})).toBe("strada");
        expect(detectTypeScriptNpmImplementation({
            optionalDependencies: {
                "@typescript/typescript-linux-x64": "7.1.0-dev.20260813.1",
            },
        })).toBe("corsa");
    });

    it("removes npm warnings in linear time", () => {
        expect(reduceSpew("before npm WARN ignored\nnpm WARN also ignored\nafter")).toBe("before after");

        const unterminatedWarnings = "npm WARN".repeat(10_000);
        expect(reduceSpew(unterminatedWarnings)).toBe(unterminatedWarnings);
    });

    it("detects a legacy TypeScript checkout", async () => {
        const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
        const repoPath = "./testDownloads/main/typescript-test-fake-error";
        actualFs.mkdirSync(repoPath, { recursive: true });
        actualFs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: "typescript" }));
        try {
            const result = await downloadTsRepoAsync('./testDownloads/main', 'https://github.com/sandersn/typescript', 'test-fake-error', 'tsc')
            expect(result.implementation).toBe("strada");
        }
        finally {
            actualFs.rmSync(repoPath, { recursive: true });
        }
    });

    it.each([
        ["typescript-go", "tsgo", "https://github.com/microsoft/typescript-go", "typescript-go"],
        ["@typescript/repo", "tsc", "https://github.com/microsoft/TypeScript", "typescript"],
    ])("detects a %s tsgo checkout", async (packageName, executableName, repoUrl, repoName) => {
        const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
        const headRef = packageName.replaceAll(/[^a-z]/g, "");
        const repoPath = `./testDownloads/main/${repoName}-${headRef}`;
        const executablePath = path.join(repoPath, "built", "local", executableName);
        actualFs.mkdirSync(path.dirname(executablePath), { recursive: true });
        actualFs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: packageName }));
        actualFs.writeFileSync(executablePath, "");
        try {
            const result = await downloadTsRepoAsync("./testDownloads/main", repoUrl, headRef, "tsc");
            expect(result.implementation).toBe("corsa");
            expect(result.tsEntrypointPath).toBe(executablePath);
        }
        finally {
            actualFs.rmSync(repoPath, { recursive: true });
        }
    });

    it.each([undefined, { mergeSha: 'merge', baseSha: 'base', headSha: 'head' }])(
        "compares a PR merge with its first parent (expected snapshot: %s)",
        async expectedPrSnapshot => {
            const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
            const repoPath = path.join("./testDownloads/main", "typescript-123");
            const basePath = path.resolve("./testDownloads/main", "typescript-123-base");
            testState.prRefs = "merge\nbase\nhead\n";
            for (const dir of [repoPath, basePath]) {
                actualFs.mkdirSync(dir, { recursive: true });
                actualFs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "typescript" }));
            }
            vi.mocked(execFileAsync).mockClear();
            try {
                const result = await downloadTsPrAsync("./testDownloads/main", "https://github.com/microsoft/TypeScript", 123, "tsc", expectedPrSnapshot);
                expect(result.baseline).toEqual({
                    tsEntrypointPath: path.join(basePath, "built/local/tsc.js"),
                    resolvedVersion: "base",
                    implementation: "strada",
                });
                expect(result.candidate.tsEntrypointPath).toBe(path.join(repoPath, "built/local/tsc.js"));
                expect(execFileAsync).toHaveBeenCalledWith(repoPath, "git", ["rev-parse", "HEAD", "HEAD^1", "HEAD^2"]);
                expect(execFileAsync).toHaveBeenCalledWith(repoPath, "git", ["worktree", "add", "--detach", basePath, "base"]);
                expect(execFileAsync).toHaveBeenCalledWith(basePath, "git", ["submodule", "update", "--init", "--recursive", "--depth=1"]);
                expect(vi.mocked(execFileAsync).mock.calls.some(([, command, args]) => command === "git" && args?.includes("main"))).toBe(false);
            }
            finally {
                testState.prRefs = undefined;
                actualFs.rmSync(basePath, { recursive: true });
                actualFs.rmSync(repoPath, { recursive: true });
            }
        },
    );

    it("rejects a changed PR snapshot before building either compiler", async () => {
        const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
        const repoPath = "./testDownloads/main/typescript-123";
        actualFs.mkdirSync(repoPath, { recursive: true });
        testState.prRefs = "merge\nbase\nhead\n";
        vi.mocked(execFileAsync).mockClear();
        try {
            await expect(downloadTsPrAsync("./testDownloads/main", "https://github.com/microsoft/TypeScript", 123, "tsc", {
                mergeSha: "merge", baseSha: "different-base", headSha: "head",
            })).rejects.toThrow("PR snapshot changed");
            expect(vi.mocked(execFileAsync).mock.calls.some(([, , args]) => args?.[0] === "worktree" || args?.[0] === "ci")).toBe(false);
        }
        finally {
            testState.prRefs = undefined;
            actualFs.rmSync(repoPath, { recursive: true });
        }
    });

    it("outputs server errors", async () => {
        testState.typeScriptSpawnResult = () => ({
            stdout: errorStdout,
            stderr: '',
            code: 5,
            signal: null,

        });

        await mainAsync({
            testType: "scheduled",
            useOverlayFs: false,
            entrypoint: 'tsserver',
            diagnosticOutput: false,
            buildWithNewWhenOldFails: false,
            repoListPath: "./artifacts/repos.json",
            workerCount: 1,
            workerNumber: 1,
            oldTsNpmVersion: 'latest',
            newTsNpmVersion: 'next',
            resultDirName: 'RepoResults123',
            prngSeed: 'testSeed',
        });

        // Remove all references to the base path so that snapshot pass successfully.
        testState.writeFile.mock.calls.forEach(e => {
            e[0] = String(e[0]).replace(process.cwd(), "<BASE_PATH>");
        });

        expect(testState.writeFile).toMatchSnapshot();
    });

    it("outputs old server errors", async () => {
        testState.typeScriptSpawnResult = args => {
            let isOldServer = args.some(x => x.includes('0.0.0'));

            // Only "old" reports an error.
            return isOldServer ? {
                stdout: errorStdout,
                stderr: '',
                code: 5,
                signal: null,
            } : {
                stdout: '',
                stderr: '',
                code: 0,
                signal: null,
            };

        };

        await mainAsync({
            testType: "scheduled",
            useOverlayFs: false,
            entrypoint: 'tsserver',
            diagnosticOutput: false,
            buildWithNewWhenOldFails: false,
            repoListPath: "./artifacts/repos.json",
            workerCount: 1,
            workerNumber: 1,
            oldTsNpmVersion: 'latest',
            newTsNpmVersion: 'next',
            resultDirName: 'RepoResults123',
            prngSeed: 'testSeed',
        });

        // Remove all references to the base path so that snapshot pass successfully.
        testState.writeFile.mock.calls.forEach(e => {
            e[0] = String(e[0]).replace(process.cwd(), "<BASE_PATH>");
        });

        expect(testState.writeFile).toMatchSnapshot();
    });
})
