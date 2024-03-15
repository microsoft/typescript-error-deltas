/// <reference types="jest" />
import { getTscRepoResult, downloadTsRepoAsync } from '../src/main'
import { execSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import path = require("path")
import { createCopyingOverlayFS } from '../src/utils/overlayFS'
describe("main", () => {
    jest.setTimeout(10 * 60 * 1000)
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
    })
    it("downloads from a branch", async () => {
        if (!existsSync("./testDownloads/main")) {
            mkdirSync("./testDownloads/main", { recursive: true });
        }
        else if (existsSync("./testDownloads/main/typescript-test-fake-error")) {
            execSync("cd ./testDownloads/main/typescript-test-fake-error && git restore . && cd ..")
        }
        await downloadTsRepoAsync('./testDownloads/main', 'https://github.com/sandersn/typescript', 'test-fake-error', 'tsc')
    })
})
