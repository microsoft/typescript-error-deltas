// @ts-check

const { assert } = require("console");
const fs = require("fs");
const { argv } = require("process");

/**
 * @typedef TestFileResult
 * @property testDir {string}
 * @property filePath {string}
 * @property results {[Result, Result, Result, Result]}
 */

/**
 * @typedef Result
 * @property regionDiagnosticsCount {number?}
 * @property regionDuration {number?}
 * @property regionDiagnostics {Diagnostic[]?}
 * @property fullDiagnosticsCount {number}
 * @property fullDuration {number}
 * @property fullDiagnostics {Diagnostic[]}
 */


let reallyBad = [];

/**
 * 
 * @param {string} resultsPath
 */
function process(resultsPath) {
    const resultsFile = fs.readFileSync(resultsPath, { encoding: "utf-8" });
    const lines = resultsFile.split("\n");
    /**
     * @type {TestFileResult[]}
     */
    const results = [];
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        if (line.startsWith("RegionResults:")) {
            // console.log(`LINE: '${lines[i + 1]}'`);
            const result = /** @type {TestFileResult[]} */(JSON.parse(lines[i + 1]));
            results.push(...result);
        }
    }

    let count = 0;
    let onlyFullDiagTotal = 0;
    let regionDiagTotal = 0;
    let fullDiagTotal = 0;
    let lineCountTotal = 0;

    let count500 = 0;
    let onlyFullDiagTotal500 = 0;
    let regionDiagTotal500 = 0;
    let fullDiagTotal500 = 0;
    let lineCountTotal500 = 0;
    let minLineCount500 = 10000000;

    let maxSoFar = 0;
    let maxFile = "";

    const testDirPlaceholder = "@PROJECT_ROOT@";

    for (const fileResult of results) {
        if (fileResult.results[2].regionDuration && fileResult.results[3].regionDuration) {
            count += 1;
            onlyFullDiagTotal += fileResult.results[0].fullDuration + fileResult.results[1].fullDuration;
            regionDiagTotal += fileResult.results[2].regionDuration + fileResult.results[3].regionDuration;
            fullDiagTotal += fileResult.results[2].fullDuration + fileResult.results[3].fullDuration;

            const tempFilePath = fileResult.filePath;
            const testDir = fileResult.testDir;
            const actualFilePath = tempFilePath.replace(new RegExp(testDirPlaceholder, "g"), testDir);
            const lineCount = getLineCount(actualFilePath);
            lineCountTotal += lineCount;

            // Compute slowest result
            if (fileResult.results[2].regionDuration > maxSoFar) {
                maxSoFar = fileResult.results[2].regionDuration;
                maxFile = fileResult.filePath;
            }

            // Compute average for slower files
            if (fileResult.results[0].fullDuration >= 500) {
                count500 += 1;
                onlyFullDiagTotal500 += fileResult.results[0].fullDuration + fileResult.results[1].fullDuration;
                regionDiagTotal500 += fileResult.results[2].regionDuration + fileResult.results[3].regionDuration;
                fullDiagTotal500 += fileResult.results[2].fullDuration + fileResult.results[3].fullDuration;

                lineCountTotal500 += lineCount;
                minLineCount500 = Math.min(minLineCount500, lineCount);
            }

            // Check consistency of diagnostics
            const deletionCompare = checkFullDiagnostics(fileResult.results[0].fullDiagnostics, fileResult.results[2].fullDiagnostics);
            const insertionCompare = checkFullDiagnostics(fileResult.results[1].fullDiagnostics, fileResult.results[3].fullDiagnostics);
            const regionDeletionCompare = checkRegionDiagnostics(fileResult.results[2].regionDiagnostics, fileResult.results[2].fullDiagnostics);
            const regionInsertionCompare = checkRegionDiagnostics(fileResult.results[3].regionDiagnostics, fileResult.results[3].fullDiagnostics);
            const regionDeletionDupl = checkForDuplicates(fileResult.results[2].fullDiagnostics);
            const regionInsertionDupl = checkForDuplicates(fileResult.results[3].fullDiagnostics);
            
            assert(
                !deletionCompare,
                `Deletion mismatch for file ${fileResult.filePath}:\n${deletionCompare}`);
            assert(
                !regionDeletionDupl,
                `Deletion duplicate for file ${fileResult.filePath}:\n${regionDeletionDupl}`);
            assert(
                !insertionCompare,
                `Insertion mismatch for file ${fileResult.filePath}:\n${insertionCompare}`);
            assert(
                    !regionInsertionDupl,
                    `Insertion duplicate for file ${fileResult.filePath}:\n${regionInsertionDupl}`);
            if (deletionCompare || insertionCompare || regionDeletionDupl || regionInsertionDupl) console.error("\n");

            assert(!regionDeletionCompare,
                `Deletion disappearance for file ${fileResult.filePath}:\n${regionDeletionCompare}`);
            assert(!regionInsertionCompare,
                `Insertion disappearance for file ${fileResult.filePath}:\n${regionInsertionCompare}`);
        }
    }

    console.log(
`Results:
Total files tested: ${results.length}
Total region tested: ${count}
Initial full average: ${onlyFullDiagTotal / (2 * count)}
Region average: ${regionDiagTotal / (2 * count)}
Full average: ${fullDiagTotal / (2 * count)}
Line count average: ${lineCountTotal / count}

Maximum region duration: ${maxSoFar}
Maximum file: '${maxFile}'

Above 500
Total files: ${count500}
Initial full average: ${onlyFullDiagTotal500 / (2 * count500)}
Region average: ${regionDiagTotal500 / (2 * count500)}
Full average: ${fullDiagTotal500 / (2 * count500)}
Line count average: ${lineCountTotal500 / count500}
Min line count: ${minLineCount500}

`);

    if (reallyBad.length) {
        console.log(`Really bad:\n${JSON.stringify(reallyBad)}`);
    }

}

/**
 * @param {string} filePath
 * @returns {number}
 */
function getLineCount(filePath) {
    const content = fs.readFileSync(filePath, { encoding: "utf-8" });
    return content.split("\n").length;
}

/**
 * @typedef {import("typescript").server.protocol.Diagnostic} Diagnostic
 */

/**
 * 
 * @param {Diagnostic[]} original 
 * @param {Diagnostic[]} modified
 * @returns {string | undefined}
 */ 
function checkFullDiagnostics(original, modified) {
    const missing = [];
    const extra = [];
    for (const o of original) {
        if (!modified.some(d => compareDiagnostic(d, o))) {
            missing.push(o);
        }
    }

    for (const m of modified) {
        if (!original.some(o => compareDiagnostic(m, o))) {
            extra.push(m);
        }
    }


    /** @type string[] */
    const report = [];
    if (original.length !== modified.length) {
        report.push(`Different lengths. Original: ${original.length}  Modified: ${modified.length}`);
    }
    
    if (missing.length || extra.length) {
        if (missing.length) {
            report.push(`Missing:\n${JSON.stringify(missing)}.`);
        }
        if (extra.length) {
            report.push(`Extra:\n${JSON.stringify(extra)}.`);
        }
    }

    return report.length ? report.join("\n") : undefined;
}

/**
 * Check if any region diagnostic is missing from the full diagnostics
 * @param {Diagnostic[]} region 
 * @param {Diagnostic[]} full
 * @returns {string | undefined}
 */ 
function checkRegionDiagnostics(region, full) {
    const disappeared = [];
    for (const r of region) {
        if (!full.some(f => compareDiagnostic(f, r))) {
            disappeared.push(r);
            if (r.code !== 2578) {
                reallyBad.push(r);
            }
        }
    }

    if (disappeared.length) {
        return `Region diagnostics disappeared:\n${JSON.stringify(disappeared)}\n`;
    }

    return undefined;
}

/**
 * @param {Diagnostic} original 
 * @param {Diagnostic} modified
 * @returns {boolean} Whether diagnostic objects are the same
 */ 
function compareDiagnostic(original, modified) {
    return isSameLocation(original.start, modified.start) &&
        isSameLocation(original.end, modified.end) &&
        compareCode(original.code, modified.code) &&
        compareMessages(original.text, modified.text);
}

function compareMessages(original, modified) {
    return original === modified;
}

function compareCode(original, modified) {
    return original === modified;
    // const suggestionCodes = [[2552, 2304], [2740, 2322]];
    // return original === modified ||
    //     suggestionCodes.some(codes => codes.includes(original) && codes.includes(modified));
}

/**
 * 
 * @param {Diagnostic[]} diagnostics
 * @returns {string | undefined}
 */
function checkForDuplicates(diagnostics) {
    const result = [];
    for (const diag of diagnostics) {
        const dupl = diagnostics.filter(d => d !== diag && isSameLocation(diag.start, d.start) && isSameLocation(diag.end, d.end));
        if (dupl.length) {
            result.push(diag);
        }
    }
    if (result.length) {
        result.sort((a, b) => a.start.line - b.start.line);
        return `Duplicate diagnostics found:\n${JSON.stringify(result)}`;
    }
}

/**
 * 
 * @param {Object} original 
 * @param {Object} modified 
 * @returns {boolean}
 */
function isSameLocation(original, modified) {
    return original.line === modified.line && original.offset === modified.offset;
}

const arg = argv[2];
process(arg);