import { getTscRepoResult, detectTypeScriptImplementation, detectTypeScriptNpmImplementation, downloadTsRepoAsync, mainAsync, reduceSpew } from '../src/main.js'
import * as path from "node:path"
import { createCopyingOverlayFS } from '../src/utils/overlayFS.js'
import type { SpawnResult } from '../src/utils/execUtils.js';
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
    typeScriptSpawnResult: undefined as ((args: readonly string[]) => SpawnResult) | undefined,
    writeFile: vi.fn(),
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
    execFileAsync: async (cwd: string, command: string, args: readonly string[] = []) => {
        if (command === "npm" && args[0] === "pack" && args[1] === "typescript@latest") {
            return ' typescript-0.0.0.tgz';
        } else if (command === "npm" && args[0] === "pack" && args[1] === "typescript@next") {
            return ' typescript-1.1.1.tgz';
        } else if (command === "git" && args[0] === "rev-parse") {
            return '57b462387e88aa7e363af0daf867a5dc1e83a935';
        }

        return '';
    }

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

    it.skip("build-only correctly caches", async () => {
        const { status, summary } = await getTscRepoResult(
            {
                name: "TypeScript-Node-Starter",
                url: "https://github.com/Microsoft/TypeScript-Node-Starter.git"
            },
            "./userTests",
            path.resolve("./typescript-main/built/local/tsc.js"),
            path.resolve("./typescript-44585/built/local/tsc.js"),
            /*ignoreOldTscFailures*/ true, // as in a user test
            await createCopyingOverlayFS("./ts_downloads", false),
            /*diagnosticOutput*/ false)
        expect(status).toEqual("NewBuildHadErrors")
        expect(summary).toBeDefined()
        expect(summary!.startsWith(`# [TypeScript-Node-Starter](https://github.com/Microsoft/TypeScript-Node-Starter.git)`)).toBeTruthy()
        expect(summary!.includes("- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\`")).toBeTruthy()
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

    it("outputs server errors", async () => {
        testState.typeScriptSpawnResult = () => ({
            stdout: errorStdout,
            stderr: '',
            code: 5,
            signal: null,

        });

        await mainAsync({
            testType: "scheduled",
            tmpfs: false,
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
            tmpfs: false,
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
