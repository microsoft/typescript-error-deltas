/// <reference types="jest" />
import { mainAsync, getRepoResult, UserParams, downloadTypescriptRepoAsync } from '../src/main'
import { execSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { UserResult } from '../src/gitUtils'
import path = require("path")
describe("main", () => {
    jest.setTimeout(10 * 60 * 1000)
    xit("build-only correctly caches", async () => {
        const { status, summary } = await getRepoResult(
            {
                name: "TypeScript-Node-Starter",
                url: "https://github.com/Microsoft/TypeScript-Node-Starter.git"
            },
            "./userTests",
            path.resolve("./typescript-main/built/local/tsc.js"),
            path.resolve("./typescript-44585/built/local/tsc.js"),
            /*ignoreOldTscFailures*/ true, // as in a user test
            "./ts_downloads",
            /*isDownloadDirOnTmpFs*/ false,
            /*diagnosticOutput*/ false)
        expect(status).toEqual("NewBuildHadErrors")
        expect(summary).toBeDefined()
        expect(summary!.startsWith(`# [TypeScript-Node-Starter](https://github.com/Microsoft/TypeScript-Node-Starter.git)`)).toBeTruthy()
        expect(summary!.includes("- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\`")).toBeTruthy()
    })
    it("downloads from a branch", async () => {
        if (!existsSync("./testDownloads/main")) {
            mkdirSync("./testDownloads/main", { recursive: true });
        }
        else if (existsSync("./testDownloads/main/typescript-test-fake-error")) {
            execSync("cd ./testDownloads/main/typescript-test-fake-error && git restore . && cd ..")
        }
        await downloadTypescriptRepoAsync('./testDownloads/main', 'https://github.com/sandersn/typescript', 'test-fake-error')
    })
})
