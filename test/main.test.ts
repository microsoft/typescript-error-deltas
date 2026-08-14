import { getTscRepoResult, downloadTsRepoAsync, isTsgoPackage, mainAsync } from '../src/main'
import { execSync } from "child_process"
import path = require("path")
import { createCopyingOverlayFS } from '../src/utils/overlayFS'
import { SpawnResult } from '../src/utils/execUtils';

jest.mock('random-seed', () => ({
    create: () => {
        return {
            random: () => 1,
            seed: () => { },
            string: () => ''
        };
    },
}));
jest.mock("../src/utils/packageUtils", () => ({
    exists: jest.fn((filePath: string) => filePath.includes("testDownloads")
        ? jest.requireActual("fs").existsSync(filePath)
        : Promise.resolve(true)),
    getMonorepoOrder: jest.fn().mockResolvedValue([
        "./dirA/package.json",
        "./dirB/dirC/package.json",
        "./dirD/DirE/dirF/package.json"
    ])
}));
jest.mock("../src/utils/execUtils", () => ({
    spawnWithTimeoutAsync: jest.fn((cwd: string, command: string, args: readonly string[], timeoutMs: number, env?: {}) => {
        if (command === 'npm') {
            // Return nothing so that npm install appears successfull.
            return {};
        }

        return typeScriptSpawnResult(args);
    }),
    execAsync: async (cwd: string, command: string) => {
        if (command.startsWith('npm pack typescript@latest')) {
            return ' typescript-0.0.0.tgz';
        } else if (command.startsWith('npm pack typescript@next')) {
            return ' typescript-1.1.1.tgz';
        } else if (command.startsWith('git rev-parse')) {
            return '57b462387e88aa7e363af0daf867a5dc1e83a935';
        }

        return '';
    }

}));
jest.mock('fs', () => ({
    promises: {
        writeFile: jest.fn(),
        copyFile: jest.fn(),
        rename: jest.fn().mockResolvedValue(undefined),
        readFile: jest.fn((path: string, options: unknown) => jest.requireActual('fs').promises.readFile(path, options)),
    },
    readFileSync: (path: string) => {
        if (path.endsWith("replay.txt")) {
            return '{\"rootDirPlaceholder\":\"@PROJECT_ROOT@\",\"serverArgs\":[\"--disableAutomaticTypingAcquisition\"]}\r\n{\"seq\":1,\"type\":\"request\",\"command\":\"configure\",\"arguments\":{\"preferences\":{\"disableLineTextInReferences\":true,\"includePackageJsonAutoImports\":\"auto\",\"includeCompletionsForImportStatements\":true,\"includeCompletionsWithSnippetText\":true,\"includeAutomaticOptionalChainCompletions\":true,\"includeCompletionsWithInsertText\":true,\"includeCompletionsWithClassMemberSnippets\":true,\"allowIncompleteCompletions\":true,\"includeCompletionsForModuleExports\":false},\"watchOptions\":{\"excludeDirectories\":[\"**/node_modules\"]}}}\r\n{\"seq\":2,\"type\":\"request\",\"command\":\"updateOpen\",\"arguments\":{\"changedFiles\":[],\"closedFiles\":[],\"openFiles\":[{\"file\":\"@PROJECT_ROOT@/sample_repoName.config.js\",\"projectRootPath\":\"@PROJECT_ROOT@\"}]}}\r\n{\"seq\":3,\"type\":\"request\",\"command\":\"cursedCommand\",\"arguments\":{\"file\":\"@PROJECT_ROOT@/src/sampleTsFile.ts\",\"line\":1,\"offset\":1,\"includeExternalModuleExports\":false,\"triggerKind\":1}}';;

        } else if (path.endsWith('repos.json')) {
            return JSON.stringify([{
                "url": "https://github.com/MockRepoOwner/MockRepoName",
                "name": "MockRepoName",
                "owner": "MockRepoOwner"
            }]);
        }
    }
}));
jest.mock('@typescript/server-replay/installPackages', () => {
    return {
        installDependencies: jest.fn().mockResolvedValue(undefined),
    }
});

let typeScriptSpawnResult: (args: readonly string[]) => SpawnResult;

const errorStdout = JSON.stringify({
    "request_seq": "123",
    "command": "cursedCommand",
    "message": "Some error. Could not do something. \nMaybe a Debug fail.\n    at a (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:1:1)\n    at b (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:2:2)\n    at c (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:3:3)\n    at d (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:4:4)\n    at e (/mnt/vss/_work/1/s/typescript-1.1.1/lib/typescript.js:5:5)"
});

describe("main", () => {
    jest.setTimeout(10 * 60 * 1000);

    it("detects tsgo from the root package name", () => {
        expect(isTsgoPackage({ name: "typescript" })).toBe(false);
        expect(isTsgoPackage({ name: "typescript-go" })).toBe(true);
        expect(isTsgoPackage({ name: "@typescript/repo" })).toBe(true);
    });

    xit("build-only correctly caches", async () => {
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
        const actualFs = jest.requireActual('fs');
        const repoPath = "./testDownloads/main/typescript-test-fake-error";
        actualFs.mkdirSync(repoPath, { recursive: true });
        actualFs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: "typescript" }));
        try {
            const result = await downloadTsRepoAsync('./testDownloads/main', 'https://github.com/sandersn/typescript', 'test-fake-error', 'tsc', false)
            expect(result.isGo).toBe(false);
        }
        finally {
            actualFs.rmSync(repoPath, { recursive: true });
        }
    });

    it.each([
        ["typescript-go", "tsgo"],
        ["@typescript/repo", "tsc"],
    ])("detects a %s tsgo checkout", async (packageName, executableName) => {
        const actualFs = jest.requireActual('fs');
        const headRef = packageName.replaceAll(/[^a-z]/g, "");
        const repoPath = `./testDownloads/main/typescript-${headRef}`;
        const executablePath = path.join(repoPath, "built", "local", executableName);
        actualFs.mkdirSync(path.dirname(executablePath), { recursive: true });
        actualFs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: packageName }));
        actualFs.writeFileSync(executablePath, "");
        try {
            const result = await downloadTsRepoAsync("./testDownloads/main", "https://github.com/microsoft/TypeScript", headRef, "tsc", false);
            expect(result.isGo).toBe(true);
            expect(result.tsEntrypointPath).toBe(executablePath);
        }
        finally {
            actualFs.rmSync(repoPath, { recursive: true });
        }
    });

    it("outputs server errors", async () => {
        const mockedFs = require('fs');

        typeScriptSpawnResult = () => ({
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
            isGo: false,
        });

        // Remove all references to the base path so that snapshot pass successfully.
        mockedFs.promises.writeFile.mock.calls.forEach((e: [string, string]) => {
            e[0] = e[0].replace(process.cwd(), "<BASE_PATH>");
        });

        expect(mockedFs.promises.writeFile).toMatchSnapshot();
    });

    it("outputs old server errors", async () => {
        const mockedFs = require('fs');

        typeScriptSpawnResult = args => {
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
            isGo: false
        });

        // Remove all references to the base path so that snapshot pass successfully.
        mockedFs.promises.writeFile.mock.calls.forEach((e: [string, string]) => {
            e[0] = e[0].replace(process.cwd(), "<BASE_PATH>");
        });

        expect(mockedFs.promises.writeFile).toMatchSnapshot();
    });
})
