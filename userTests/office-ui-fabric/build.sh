npm i -g yarn
rm -rf office-ui-fabric
CI=true
TF_BUILD=true
# Download repo version, sets up better layer caching for the following clone
curl https://api.github.com/repositories/60537144/git/ref/heads/master -o version.json
git clone --depth 1 https://github.com/OfficeDev/office-ui-fabric-react.git office-ui-fabric-react
START=$(pwd)
cd $TS
rm ~/.config/yarn/link/typescript
yarn link
cd $START/office-ui-fabric-react
yarn link typescript
yarn
# Sync up all TS versions used internally to the new one (we use `npm` because `yarn` chokes on tarballs installed
# into multiple places in a workspace in a short timeframe (some kind of data race))
# sed -i -e 's/"resolutions": {/"resolutions": { "\*\*\/typescript": "file:\/typescript\.tgz",/g' package.json
# npx yarn

npx lerna exec --stream --concurrency 1 --loglevel error --bail=false -- yarn run just ts
