import * as path from 'path'
import { buildAndGetErrors } from '../src/getErrors'
describe("getErrors", () => {
    jest.setTimeout(10 * 60 * 1000)
    it("builds a simple project one time", async () => {
        const errors = await buildAndGetErrors(
            "./testResources/simpleProject",
            // TODO: Depends on downloading and building 44585 in main.test.ts
            path.resolve("./testDownloads/typescript-test-fake-error/built/local/tsc.js"),
            /*topGithubRepos*/ false,
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
            // TODO: Depends on downloading and building 44585 in main.test.ts
            path.resolve("./testDownloads/typescript-test-fake-error/built/local/tsc.js"),
            /*topGithubRepos*/ false,
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
            // TODO: Depends on downloading and building 44585 in main.test.ts
            path.resolve("./testDownloads/typescript-test-fake-error/built/local/tsc.js"),
            /*topGithubRepos*/ false,
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