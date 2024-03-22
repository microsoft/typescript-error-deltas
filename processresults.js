// @ts-check

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
 * @property fullDiagnosticsCount {number}
 * @property fullDuration {number}
 */

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

    let onlyFullDiagTotal = 0;
    const onlyFullDiagCount = 2 * results.length;
    let regionDiagTotal = 0;
    let regionDiagCount = 0;
    let fullDiagTotal = 0;
    const fullDiagCount = 2 * results.length;

    let maxSoFar = 0;
    let maxIdx = -1;

    for (const fileResult of results) {
        onlyFullDiagTotal += fileResult.results[0].fullDuration + fileResult.results[1].fullDuration;
        if (fileResult.results[2].regionDuration) {
            regionDiagTotal += fileResult.results[2].regionDuration;
            regionDiagCount += 1;
        }
        if (fileResult.results[3].regionDuration) {
            regionDiagTotal += fileResult.results[3].regionDuration;
            regionDiagCount += 1;
        }
        fullDiagTotal += fileResult.results[2].fullDuration + fileResult.results[3].fullDuration;
    }

    console.log(
`Results:
Total files tested: ${results.length}
Initial full average: ${onlyFullDiagTotal / onlyFullDiagCount}
Region average: ${regionDiagTotal / regionDiagCount}
Region count: ${regionDiagCount}
Full average: ${fullDiagTotal / fullDiagCount}
`);
}

const arg = argv[2];
process(arg);