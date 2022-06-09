import process = require("process");
import ge = require("./getErrors");

if (!process.send) process.exit(1);

process.send('ready');

process.on('message', ({repoDir, tscPath, topGithubRepos, skipLibCheck}) => {
    ge.buildAndGetErrors(repoDir, tscPath, topGithubRepos, skipLibCheck)
      .then(r => { process.send!(r), process.exit(); });
});
