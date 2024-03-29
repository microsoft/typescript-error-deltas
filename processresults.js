// @ts-check

const { assert } = require("console");
const fs = require("fs");
const { argv } = require("process");

/**
 * @typedef TestFileResult
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

    let count500 = 0;
    let onlyFullDiagTotal500 = 0;
    let regionDiagTotal500 = 0;
    let fullDiagTotal500 = 0;

    let maxSoFar = 0;
    let maxFile = "";

    for (const fileResult of results) {
        if (fileResult.results[2].regionDuration && fileResult.results[3].regionDuration) {
            count += 1;
            onlyFullDiagTotal += fileResult.results[0].fullDuration + fileResult.results[1].fullDuration;
            regionDiagTotal += fileResult.results[2].regionDuration + fileResult.results[3].regionDuration;
            fullDiagTotal += fileResult.results[2].fullDuration + fileResult.results[3].fullDuration;

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
            }

            // Check consistency of diagnostics
            const deletionCompare = checkFullDiagnostics(fileResult.results[0].fullDiagnostics, fileResult.results[2].fullDiagnostics);
            const insertionCompare = checkFullDiagnostics(fileResult.results[1].fullDiagnostics, fileResult.results[3].fullDiagnostics);
            const regionDeletionCompare = checkRegionDiagnostics(fileResult.results[2].regionDiagnostics, fileResult.results[2].fullDiagnostics);
            const regionInsertionCompare = checkRegionDiagnostics(fileResult.results[3].regionDiagnostics, fileResult.results[3].fullDiagnostics);
            assert(
                !deletionCompare,
                `Deletion mismatch for file ${fileResult.filePath}:\n${deletionCompare}`);
            assert(
                !insertionCompare,
                `Insertion mismatch for file ${fileResult.filePath}:\n${insertionCompare}`);
            if (deletionCompare || insertionCompare) console.error("\n");

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

Maximum region duration: ${maxSoFar}
Maximum file: '${maxFile}'

Above 500
Initial full average: ${onlyFullDiagTotal500 / (2 * count500)}
Region average: ${regionDiagTotal500 / (2 * count500)}
Full average: ${fullDiagTotal500 / (2 * count500)}

`);

    if (reallyBad.length) {
        console.log(`Really bad:\n${JSON.stringify(reallyBad)}`);
    }

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

    if (missing.length || extra.length) {
        const report = [];
        if (missing.length) {
            report.push(`Missing:\n${JSON.stringify(missing)}.`);
        }
        if (extra.length) {
            report.push(`Extra:\n${JSON.stringify(extra)}.`);
        }
        return report.join("\n");
    }

    return undefined;
}

/**
 * 
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
        original.text === modified.text &&
        original.code === modified.code;
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