rm -rf pyright
git clone --depth 1 https://github.com/microsoft/pyright.git pyright
START=$(pwd)
cd $TS
npm link
cd $START/pyright
npm i
npm link typescript


npx lerna exec --stream --concurrency 1 -- npm link typescript
npx lerna exec --stream --concurrency 1 --no-bail -- tsc --noEmit
