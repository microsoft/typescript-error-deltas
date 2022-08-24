import { existsSync, mkdirSync } from "fs"
import * as path from 'path'
import { buildAndGetErrors } from '../src/utils/getTscErrors'
import { downloadTsRepoAsync } from '../src/main'
describe("getErrors", () => {
    jest.setTimeout(10 * 60 * 1000)

    beforeAll(async () => {
        if (!existsSync("./testDownloads/getErrors/typescript-test-fake-error/built/local/tsc.js")) {
            if (!existsSync("./testDownloads/getErrors")) {
                mkdirSync("./testDownloads/getErrors", { recursive: true });
            }
            await downloadTsRepoAsync('./testDownloads/getErrors', 'https://github.com/sandersn/typescript', 'test-fake-error', 'tsc');
        }
    });

    it("builds a simple project one time", async () => {
        const errors = await buildAndGetErrors(
            "./testResources/simpleProject",
            /*isUserTestRepo*/ true,
            path.resolve("./testDownloads/getErrors/typescript-test-fake-error/built/local/tsc.js"),
            /*timeoutMs*/ 1e6,
            /*skipLibCheck*/ true,
        )
        expect(errors.hasConfigFailure).toBeFalsy()
        expect(errors.projectErrors).toHaveLength(1)
        expect(errors.projectErrors[0].errors.length).toBe(1)
        expect(errors.projectErrors[0].errors[0]).toMatchObject({
            code: 2496,
            text: "error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.",
        })
        expect(errors.projectErrors[0].errors[0].fileUrl?.endsWith("testResources/simpleProject/main.ts(1,35)")).toBeTruthy()
        expect(errors.projectErrors[0].errors[0].projectUrl?.endsWith("testResources/simpleProject/tsconfig.json")).toBeTruthy()
    })
    it("builds a script project one time", async () => {
        const errors = await buildAndGetErrors(
            "./testResources/scriptProject",
            /*isUserTestRepo*/ true,
            path.resolve("./testDownloads/getErrors/typescript-test-fake-error/built/local/tsc.js"),
            /*timeoutMs*/ 1e6,
            /*skipLibCheck*/ true,
        )
        expect(errors.hasConfigFailure).toBeFalsy()
        expect(errors.projectErrors).toHaveLength(1)
        expect(errors.projectErrors[0].errors.length).toBe(1)
        expect(errors.projectErrors[0].errors[0]).toMatchObject({
            code: 2496,
            text: "error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.",
        })
        expect(errors.projectErrors[0].errors[0].fileUrl?.endsWith("testResources/scriptProject/main.ts(1,35)")).toBeTruthy()
        expect(errors.projectErrors[0].errors[0].projectUrl).toEqual("testResources/scriptProject/build.sh")
    })
    xit("builds Real Live prettier, For Real", async () => {
        const errors = await buildAndGetErrors(
            "./testResources/scriptPrettier",
            /*isUserTestRepo*/ false,
            path.resolve("./testDownloads/getErrors/typescript-test-fake-error/built/local/tsc.js"),
            /*timeoutMs*/ 1e6,
            /*skipLibCheck*/ true,
        )
        expect(errors.hasConfigFailure).toBeFalsy()
        expect(errors.projectErrors).toHaveLength(1)
        expect(errors.projectErrors[0].errors.length).toBe(37)
        expect(errors.projectErrors[0].errors[0]).toMatchObject({
            code: 2496,
            text: "error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.",
        })
        expect(errors.projectErrors[0].errors[0].fileUrl?.endsWith("src/cli/logger.js(31,23)")).toBeTruthy()
        expect(errors.projectErrors[0].errors[0].projectUrl).toEqual("testResources/scriptPrettier/build.sh")
    })
})
