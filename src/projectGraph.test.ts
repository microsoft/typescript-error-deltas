import path = require('path')
import { getProjectsToBuild } from './projectGraph'

describe("getProjectsToBuild", () => {
    it("gets a simple project", () => {
        const result = getProjectsToBuild("./test/simpleProject")
        expect(result.simpleProjects[0].path.endsWith("test/simpleProject/tsconfig.json"))
        delete (result.simpleProjects[0] as any).path
        expect(result).toEqual({
            simpleProjects: [{
                hasParseError: false,
                hasExtensionError: false,
                hasReferenceError: false,
                isComposite: false,
                references: [],
                referencedBy: [],
                extends: [],
                extendedBy: [],
                contents: '',
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
                contents: "node $TS/built/local/tsc.js --skipLibCheck --incremental false --pretty false main.ts\n",
                hasParseError: false,
                hasExtensionError: false,
                hasReferenceError: false,
                isComposite: false,
                references: [],
                referencedBy: [],
                extends: [],
                extendedBy: [],
            }],
            hasError: false,
        })
    })
})
