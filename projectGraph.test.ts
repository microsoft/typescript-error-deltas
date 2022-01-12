import path = require('path')
import { getProjectsToBuild } from './projectGraph'

describe("getProjectsToBuild", () => {
    it("gets a simple project", () => {
        expect(getProjectsToBuild("./test/simpleProject")).toEqual({
            simpleProjects: [{
                // TODO: Assertion only on the end of the path
                path: "/home/nathansa/src/TypeScriptErrorDeltas/test/simpleProject/tsconfig.json",
                hasParseError: false,
                hasExtensionError: false,
                hasReferenceError: false,
                isComposite: false,
                references: [],
                referencedBy: [],
                extends: [],
                extendedBy: [],
            }],
            rootCompositeProjects: [],
            scriptedProjects: [],
            hasError: false,
        })
    })
    it("gets a script project", () => {
        expect(getProjectsToBuild("./test/scriptProject")).toEqual({
            simpleProjects: [],
            rootCompositeProjects: [],
            scriptedProjects: [{
                path: "test/scriptProject/build.sh",
                contents: "tsc main.ts\n",
            }],
            hasError: false,
        })
    })
})
